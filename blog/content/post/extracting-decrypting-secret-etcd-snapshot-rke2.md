---
title: "Decrypt One Secret From an RKE2 etcd Snapshot"
date: 2024-09-04T04:48:35-05:00
lastmod: 2026-10-23
draft: false
tags: ["RKE2", "etcd", "Kubernetes", "Secrets", "Encryption at Rest", "etcdutl", "Backup"]
categories:
- RKE2
- etcd
- "Backup & Recovery"
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Pull one Secret out of an RKE2 etcd snapshot without restoring the cluster: restore to a temp dir, read the key, decrypt it with the aescbc key."
more_link: "yes"
quick_fix: |
  Restore the snapshot into a scratch directory with `etcdutl snapshot restore <snapshot> --data-dir /tmp/etcd-restore`, start a throwaway etcd on 127.0.0.1 against it, and read `/registry/secrets/<namespace>/<name>`.
  On RKE2 the value starts with `k8s:enc:aescbc:v1:<key-name>:` because secrets are encrypted at rest; decrypt it with the matching key from `/var/lib/rancher/rke2/server/cred/encryption-config.json`, or point a temporary kube-apiserver at the scratch etcd with that file and use `kubectl get secret`.
---

Someone deleted a Secret, or rotated a credential and lost the old value, and the only copy left is in last night's RKE2 etcd snapshot. Restoring the whole cluster to get one object back is out of the question. This guide restores the snapshot into a scratch etcd that has nothing to do with the live cluster, reads the one key you need, and decrypts it, because on RKE2 every Secret in etcd is encrypted at rest.

<!--more-->

If your cluster does not encrypt secrets at rest, the shorter walkthrough in [Pulling Data from an etcd Backup](/pulling-data-etcd-backup-extract-secret/) covers the plain case. Everything below was run end to end with etcd 3.6.5, kube-apiserver v1.34.1 and an `aescbc` encryption config in the same format RKE2 writes.

## What is actually in the snapshot

Three facts decide the whole procedure:

1. **An etcd snapshot is a bbolt database file, not something `etcdctl get` can read directly.** You have to restore it into a data directory and run an etcd process on it. etcd 3.6 removed `etcdctl snapshot restore` and `etcdctl snapshot status`; use `etcdutl` for both (it also works on 3.5). On etcd 3.4 and older there is no `etcdutl`; run `etcdctl snapshot status` and `etcdctl snapshot restore` with the same arguments. On 3.5 those `etcdctl` forms still work but print a deprecation warning. On 3.6 and later they are gone, and `etcdctl snapshot status file.db` just prints help and exits 0, so a script that checks the exit code will think it worked.
2. **The value of a Secret key is not JSON.** The kube-apiserver stores objects as protobuf with a `k8s\0` magic prefix. Even unencrypted, `base64 -d` on the value gives you binary, not YAML.
3. **RKE2 encrypts Secrets at rest by default.** RKE2 generates an AES-CBC key, writes `/var/lib/rancher/rke2/server/cred/encryption-config.json` and passes it to the API server. Every Secret value in etcd therefore starts with `k8s:enc:aescbc:v1:<key-name>:`, and you need the key from that file to read it.

So the job is: restore, read the raw value, decrypt with the right key, decode the protobuf.

## Step 1: Collect the snapshot and the encryption config

RKE2 writes local snapshots to `${data-dir}/db/snapshots`, which is `/var/lib/rancher/rke2/server/db/snapshots` with the default data dir. Scheduled snapshots are named `etcd-snapshot-<node>-<timestamp>`, on-demand ones `on-demand-<node>-<timestamp>`. If you ship snapshots to S3, download the file from the bucket instead.

```bash
# On an RKE2 server node
sudo ls -lh /var/lib/rancher/rke2/server/db/snapshots/
sudo rke2 etcd-snapshot list          # also shows S3 snapshots when S3 is configured
sudo rke2 secrets-encrypt status      # confirms encryption is enabled and shows the active key name
```

Copy the snapshot and the encryption config to a workstation or a scratch VM. Treat both as secrets: together they decrypt every Secret in the cluster.

```bash
mkdir -p ~/etcd-recover && cd ~/etcd-recover
sudo cp /var/lib/rancher/rke2/server/db/snapshots/etcd-snapshot-server-0-1729651200 ./snapshot.db
sudo cp /var/lib/rancher/rke2/server/cred/encryption-config.json ./encryption-config.json
sudo chown "$USER" snapshot.db encryption-config.json
chmod 600 snapshot.db encryption-config.json
```

Snapshots taken with `--etcd-snapshot-compress` have a `.zip` suffix; copy that file instead, `unzip` it, and use the file inside as `snapshot.db`.

> [!WARNING]
> The encryption config must contain the key that was active **when the snapshot was taken**. After `rke2 secrets-encrypt rotate-keys` (or the older prepare, rotate, reencrypt sequence) finishes, the old key is dropped from the file and older snapshots can no longer be decrypted with the current config. Keep a copy of the config next to each snapshot you archive, or recover it from the snapshot itself as described in the FAQ.

The config looks like this (RKE2 names the first key `aescbckey`; keys created by `rke2 secrets-encrypt rotate-keys` are named `aescbckey-<RFC 3339 timestamp>`):

```json {filename="encryption-config.json"}
{
  "kind": "EncryptionConfiguration",
  "apiVersion": "apiserver.config.k8s.io/v1",
  "resources": [
    {
      "resources": ["secrets"],
      "providers": [
        {"aescbc": {"keys": [{"name": "aescbckey-2026-10-23T08:00:00Z", "secret": "<base64 32-byte key>"}]}},
        {"identity": {}}
      ]
    }
  ]
}
```

## Step 2: Restore the snapshot into a scratch data directory

You need `etcdutl` and `etcd` binaries. Grab them from the [etcd releases page](https://github.com/etcd-io/etcd/releases) or use the upstream image, which ships `etcd`, `etcdctl` and `etcdutl`. The commands below use the image so nothing gets installed on the host.

Do not try to run `etcdutl` on an RKE2 node. The `rancher/hardened-etcd` static pod image contains only `etcd` and `etcdctl` and has no shell, and RKE2 installs neither tool on the host. RKE2 v1.34 to v1.36 currently ship etcd 3.6.14 and v1.37 ships 3.7.1, so a 3.6.x upstream image matches.

```bash
ETCD_IMG=registry.k8s.io/etcd:3.6.5-0

docker run --rm -v "$PWD":/work --entrypoint etcdutl "$ETCD_IMG" \
  snapshot status /work/snapshot.db -w table

docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/work --entrypoint etcdutl "$ETCD_IMG" \
  snapshot restore /work/snapshot.db --data-dir /work/restore
```

`snapshot status` prints the hash, revision, key count and size, which is a quick integrity check before you go further. `snapshot restore` writes a fresh single member data directory under `./restore`. It does not touch the original cluster, and the restored member gets a new cluster ID and default member name, so it cannot accidentally join anything.

If you are working from a raw `member/snap/db` file copied off a dead node instead of a real snapshot, add `--skip-hash-check`; such files have no snapshot hash appended.

## Step 3: Start a throwaway etcd and read the key

Bind the scratch etcd to loopback only. There is no TLS and no auth on it, and it holds every Secret in the cluster.

```bash
docker run -d --name etcd-recover --user "$(id -u):$(id -g)" -v "$PWD":/work "$ETCD_IMG" etcd \
  --data-dir=/work/restore \
  --listen-client-urls=http://127.0.0.1:2379 \
  --advertise-client-urls=http://127.0.0.1:2379 \
  --listen-peer-urls=http://127.0.0.1:2380

# Find the key
docker exec etcd-recover etcdctl get /registry/secrets/default/ --prefix --keys-only

# Dump the raw value to a file
docker exec etcd-recover etcdctl get /registry/secrets/default/db-creds \
  --print-value-only > raw.bin
truncate -s -1 raw.bin   # etcdctl appends a newline after the value
```

Secrets live under `/registry/secrets/<namespace>/<name>`. Look at the first bytes to confirm what you are dealing with:

```bash
head -c 48 raw.bin; echo
# k8s:enc:aescbc:v1:aescbckey-2026-10-23T08:00:00Z:
```

On a cluster that never rotated keys this reads `k8s:enc:aescbc:v1:aescbckey:`.

If the prefix is `k8s` followed by a NUL byte instead, the Secret was stored unencrypted (encryption was off or the Secret predates it) and you can skip to Step 5.

## Step 4: Decrypt the value with the aescbc key

The `aescbc` provider stores `k8s:enc:aescbc:v1:<key-name>:`, then a 16-byte IV, then the AES-256-CBC ciphertext with PKCS#7 padding. That is all you need to decrypt it with `openssl`. The script below picks the key whose name matches the prefix, which matters when the config holds more than one key during a rotation. Key names contain colons, so it compares the whole prefix rather than splitting on `:`.

```bash {filename="decrypt-secret.sh"}
#!/usr/bin/env bash
# decrypt-secret.sh RAW_VALUE_FILE ENCRYPTION_CONFIG
# Decrypts an aescbc-encrypted Kubernetes Secret value read from etcd.
set -euo pipefail
raw="$1"
config="$2"

for name in $(jq -r '.resources[].providers[].aescbc.keys[]?.name' "$config"); do
  prefix="k8s:enc:aescbc:v1:${name}:"
  if [ "$(head -c ${#prefix} "$raw")" = "$prefix" ]; then
    key_hex=$(jq -r --arg n "$name" \
      '.resources[].providers[].aescbc.keys[]? | select(.name==$n) | .secret' "$config" \
      | base64 -d | xxd -p -c 64)
    # Layout after the prefix: 16-byte IV, then AES-256-CBC ciphertext (PKCS#7 padded)
    iv_hex=$(tail -c +$(( ${#prefix} + 1 )) "$raw" | head -c 16 | xxd -p)
    tail -c +$(( ${#prefix} + 17 )) "$raw" \
      | openssl enc -d -aes-256-cbc -K "$key_hex" -iv "$iv_hex"
    exit 0
  fi
done
echo "no aescbc key in $config matches $(head -c 60 "$raw" | tr -c '[:print:]' '.')" >&2
exit 1
```

```bash
chmod +x decrypt-secret.sh
./decrypt-secret.sh raw.bin encryption-config.json > secret.pb
head -c 4 secret.pb | od -c
# 0000000   k   8   s  \0
```

The `k8s\0` magic means decryption worked. A `bad decrypt` error from `openssl` means the key is wrong, almost always because the config is newer than the snapshot.

## Step 5: Decode the protobuf into YAML

[auger](https://github.com/etcd-io/auger), maintained under etcd-io, decodes the storage format into YAML:

```bash
go install github.com/etcd-io/auger@latest
auger decode < secret.pb
```

```yaml
apiVersion: v1
data:
  password: czNjcjN0LWZyb20tYmFja3Vw
kind: Secret
metadata:
  creationTimestamp: "2026-10-23T13:42:23Z"
  name: db-creds
  namespace: default
  uid: 9322eb90-b257-4350-94d7-61251a2e6432
type: Opaque
```

The `data` values are ordinary Secret base64. To put the Secret back in the live cluster, strip the server-managed fields and apply it:

```bash
auger decode < secret.pb \
  | yq 'del(.metadata.uid, .metadata.resourceVersion, .metadata.creationTimestamp, .metadata.managedFields)' \
  > db-creds.yaml
kubectl apply -f db-creds.yaml
```

If you only need one value, `strings secret.pb` shows the keys and values in plain text, which is often enough to read a password off the screen.

## Alternative: let a temporary kube-apiserver decrypt it

For `secretbox` (the other provider RKE2 can use, selected with `--secrets-encryption-provider`), for many Secrets at once, or if you would rather not handle the crypto yourself, run a kube-apiserver against the scratch etcd with the same encryption config. The API server decrypts and decodes, and you use plain `kubectl`. Match the API server version to the cluster version.

```bash
# Throwaway credentials for the temporary API server only
openssl genrsa -out sa.key 2048
openssl rsa -in sa.key -pubout -out sa.pub
openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 1 -subj /CN=localhost
echo "recover-token,admin,admin,system:masters" > tokens.csv

docker run -d --name apiserver-recover --network container:etcd-recover \
  -v "$PWD":/work:ro registry.k8s.io/kube-apiserver:v1.34.1 kube-apiserver \
  --etcd-servers=http://127.0.0.1:2379 \
  --encryption-provider-config=/work/encryption-config.json \
  --service-account-issuer=https://kubernetes.default.svc \
  --service-account-key-file=/work/sa.pub \
  --service-account-signing-key-file=/work/sa.key \
  --token-auth-file=/work/tokens.csv \
  --authorization-mode=RBAC \
  --tls-cert-file=/work/tls.crt --tls-private-key-file=/work/tls.key \
  --service-cluster-ip-range=10.43.0.0/16 \
  --bind-address=127.0.0.1 --secure-port=16443
```

`--network container:etcd-recover` shares the etcd container's network namespace, so both stay on loopback. Run `kubectl` the same way, from a container in that namespace:

```bash
docker run --rm --network container:etcd-recover --entrypoint kubectl bitnami/kubectl:latest \
  --server=https://127.0.0.1:16443 --token=recover-token --insecure-skip-tls-verify \
  get secret db-creds -n default -o yaml
```

The temporary API server writes to the scratch etcd as it starts (default namespaces, endpoints and so on). That is harmless because the data directory is disposable, but it is another reason never to point it at a real etcd member.

## Clean up

```bash
docker rm -f apiserver-recover etcd-recover
shred -u snapshot.db encryption-config.json raw.bin secret.pb sa.key tls.key tokens.csv 2>/dev/null
rm -rf restore
```

## FAQ

### The node with encryption-config.json is gone. Can I still decrypt?

Any surviving RKE2 server has the same file. If all servers are gone, the snapshot still carries the cluster's bootstrap data, including secrets encryption config, encrypted with a key derived from the server token. RKE2 restores it when you run `rke2 server --cluster-reset --cluster-reset-restore-path=<snapshot> --token=<original token>` on a scratch VM, after which `/var/lib/rancher/rke2/server/cred/encryption-config.json` is back on disk. Without the original token there is no way to recover the key.

### Why not just run `rke2 server --cluster-reset` on a spare VM every time?

You can, and it gives you a full cluster view, but it boots the whole control plane and every workload controller against your data. The scratch etcd approach reads one key, takes a minute, and runs nothing that can act on the restored state.

### Can I read the snapshot without restoring it?

Not with etcd tools. The snapshot is a bbolt file, so a bbolt browser can open it, but the MVCC key encoding makes that painful. Restoring to a scratch directory is the supported path.

### Does this work for ConfigMaps and other resources?

Yes for reading: everything lives under `/registry/<resource>/<namespace>/<name>`. RKE2 only encrypts `secrets` by default, so other resources start with `k8s\0` and go straight to `auger decode`.

## Related guides

- [Pulling Data from an etcd Backup Without a Full Restore](/pulling-data-etcd-backup-extract-secret/)
- [RKE2 Standalone Disaster Recovery Guide](/post/rke2-standalone-disaster-recovery/)
- [Monitor an etcd Cluster with Grafana and Prometheus in RKE2](/monitor-etcd-cluster-grafana-prometheus-rke2/)
- [Deep Dive into etcd and Kubernetes](/post/deep-dive-etcd-kubernetes/)
