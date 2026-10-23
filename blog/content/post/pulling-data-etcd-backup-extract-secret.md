---
title: "Extract a Kubernetes Secret From an etcd Snapshot"
date: 2024-10-18T19:26:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["etcd", "Kubernetes", "Backup", "Secrets", "Troubleshooting", "etcdutl", "auger"]
categories:
- Kubernetes
- "Backup & Recovery"
- etcd
author: "Matthew Mattox - mmattox@support.tools"
description: "Get one Secret back from an etcd snapshot without a cluster restore: etcdutl restore to a scratch dir, loopback etcd, etcdctl get, then decode the protobuf."
more_link: "yes"
url: "/pulling-data-etcd-backup-extract-secret/"
quick_fix: |
  A snapshot is not readable by `etcdctl get` directly. Run `etcdutl snapshot restore snapshot.db --data-dir ./restore`, start a throwaway etcd on 127.0.0.1 against `./restore`, then `etcdctl get /registry/secrets/<namespace>/<name> --print-value-only > raw.bin`.
  The value is Kubernetes protobuf (it starts with `k8s` and a NUL byte), not JSON: decode it with `auger decode < raw.bin`. If it starts with `k8s:enc:` instead, it is encrypted at rest and needs the API server's encryption key first.
---

Someone deleted a Secret, or overwrote it, and the only copy left is in an etcd snapshot. Restoring the whole cluster to get one object back would roll every other resource back too. This guide restores the snapshot into a scratch etcd that has nothing to do with the live cluster, reads the one key you need, and decodes it into normal Secret YAML.

<!--more-->

This post covers the case where the Secret is stored **unencrypted** in etcd, which is the upstream Kubernetes default when the API server has no `--encryption-provider-config`. If your cluster encrypts Secrets at rest (RKE2 does by default), follow [Decrypt One Secret From an RKE2 etcd Snapshot](/post/extracting-decrypting-secret-etcd-snapshot-rke2/) instead; Step 4 below shows how to tell which case you are in.

Everything below was run end to end with etcd 3.6.5 and kube-apiserver v1.34.1. The output blocks are copied from that run.

## Two things that trip people up

1. **`etcdctl` cannot read a snapshot file.** There is no `--snapshot` flag on `etcdctl get`. A snapshot is a bbolt database; you have to restore it into a data directory and run an etcd process on it. In etcd 3.6, `etcdctl snapshot restore` and `etcdctl snapshot status` were removed, so use `etcdutl` for both (it works on 3.5 as well). On etcd 3.4 and older there is no `etcdutl`; run `etcdctl snapshot status` and `etcdctl snapshot restore` with the same arguments. On 3.5 those `etcdctl` forms still work but print a deprecation warning. On 3.6 and later they are gone, and `etcdctl snapshot status file.db` just prints help and exits 0, so a script that checks the exit code will think it worked.
2. **The value is protobuf, not JSON.** The kube-apiserver stores objects in a binary protobuf envelope that starts with the 4-byte magic `k8s\0`. `etcdctl get -w json` base64-encodes that binary, so decoding it with `base64 -d` gives you protobuf bytes, not a readable Secret.

## Step 1: Get the snapshot and the tools

Copy the snapshot somewhere other than a control plane node. On kubeadm clusters you usually took it with `etcdctl snapshot save`; managed distributions keep their own snapshot directories. Treat the file as sensitive: it contains every Secret in the cluster.

You need `etcd`, `etcdctl` and `etcdutl`. The upstream etcd image has all three, so nothing has to be installed on the host:

```bash
mkdir -p ~/etcd-recover && cd ~/etcd-recover
cp /path/to/snapshot.db .
ETCD_IMG=registry.k8s.io/etcd:3.6.5-0
```

The binaries are also on the [etcd releases page](https://github.com/etcd-io/etcd/releases) if you prefer them directly.

## Step 2: Check and restore the snapshot into a scratch directory

```bash
docker run --rm -v "$PWD":/work --entrypoint etcdutl "$ETCD_IMG" \
  snapshot status /work/snapshot.db -w table
```

```text
+----------+----------+------------+------------+---------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE | VERSION |
+----------+----------+------------+------------+---------+
| c6c8e132 |      205 |        187 |     242 kB |   3.6.0 |
+----------+----------+------------+------------+---------+
```

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/work --entrypoint etcdutl "$ETCD_IMG" \
  snapshot restore /work/snapshot.db --data-dir /work/restore
```

The restore writes a new single member data directory under `./restore` with a fresh cluster ID, so it cannot join or disturb the real cluster. If you only have a raw `member/snap/db` file copied off a dead node rather than a real snapshot, add `--skip-hash-check`.

## Step 3: Start a throwaway etcd on loopback and find the key

```bash
docker run -d --name etcd-recover --user "$(id -u):$(id -g)" -v "$PWD":/work "$ETCD_IMG" etcd \
  --data-dir=/work/restore \
  --listen-client-urls=http://127.0.0.1:2379 \
  --advertise-client-urls=http://127.0.0.1:2379 \
  --listen-peer-urls=http://127.0.0.1:2380

docker exec etcd-recover etcdctl get /registry/secrets/default/ --prefix --keys-only
```

```text
/registry/secrets/default/db-creds
```

Secrets live under `/registry/secrets/<namespace>/<name>`. The scratch etcd has no TLS and no authentication, which is why it listens only on 127.0.0.1 inside its container.

## Step 4: Read the raw value and check whether it is encrypted

This is what the JSON output actually contains (truncated):

```bash
docker exec etcd-recover etcdctl get /registry/secrets/default/db-creds -w json
```

```text
{"header":{...,"revision":205,"raft_term":2},"kvs":[{"key":"L3JlZ2lzdHJ5L3NlY3JldHMvZGVmYXVsdC9kYi1jcmVkcw==",...,"value":"azhzAAoMCgJ2MRIGU2VjcmV0Et4BCrMBCghkYi1jcmVkcxIAGgdkZWZhdWx0IgAqJ...
```

`azhzAA` is base64 for `k8s\0`. Save the raw bytes instead:

```bash
docker exec etcd-recover etcdctl get /registry/secrets/default/db-creds \
  --print-value-only > raw.bin
truncate -s -1 raw.bin   # etcdctl appends a newline after the value
head -c 32 raw.bin | od -c | head -2
```

```text
0000000   k   8   s  \0  \n  \f  \n 002   v   1 022 006   S   e   c   r
0000020   e   t 022 336 001  \n 263 001  \n  \b   d   b   -   c   r   e
```

The first bytes tell you which case you have:

| Value starts with | Meaning | Next step |
|---|---|---|
| `k8s` and a NUL byte | Plain protobuf, not encrypted | Step 5 |
| `k8s:enc:aescbc:v1:`, `k8s:enc:aesgcm:v1:`, `k8s:enc:secretbox:v1:` or `k8s:enc:kms:` | Encrypted at rest | Decrypt with the API server's encryption key first; see the [RKE2 encrypted guide](/post/extracting-decrypting-secret-etcd-snapshot-rke2/) |
| `{` | JSON storage, only from clusters configured for JSON storage media type | Already readable |

## Step 5: Decode the protobuf

### Option A: `auger`

[auger](https://github.com/etcd-io/auger), maintained under etcd-io, decodes the storage format into YAML or JSON:

```bash
go install github.com/etcd-io/auger@latest
auger decode < raw.bin
```

```yaml
apiVersion: v1
data:
  password: czNjcjN0LWZyb20tYmFja3Vw
kind: Secret
metadata:
  creationTimestamp: "2026-10-23T14:50:18Z"
  managedFields:
  - apiVersion: v1
    fieldsType: FieldsV1
    fieldsV1:
      f:data:
        .: {}
        f:password: {}
      f:type: {}
    manager: kubectl-create
    operation: Update
    time: "2026-10-23T14:50:18Z"
  name: db-creds
  namespace: default
  uid: e2d2d04c-53e3-4a2a-b968-656c73f06054
type: Opaque
```

The values under `data` are ordinary Secret base64: `echo czNjcjN0LWZyb20tYmFja3Vw | base64 -d` prints `s3cr3t-from-backup`. Use `auger decode -o json` for JSON output.

To put the Secret back, strip the server-managed fields and apply it to the live cluster:

```bash
auger decode < raw.bin \
  | yq 'del(.metadata.uid, .metadata.resourceVersion, .metadata.creationTimestamp, .metadata.managedFields)' \
  > db-creds.yaml
kubectl apply -f db-creds.yaml
```

### Option B: a temporary kube-apiserver

If you need many objects, or would rather use `kubectl`, run a kube-apiserver of the same version as the cluster against the scratch etcd. It needs throwaway service account keys, a serving certificate and a token file:

```bash
openssl genrsa -out sa.key 2048
openssl rsa -in sa.key -pubout -out sa.pub
openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 1 -subj /CN=localhost
echo "recover-token,admin,admin,system:masters" > tokens.csv

docker run -d --name apiserver-recover --network container:etcd-recover \
  -v "$PWD":/work:ro registry.k8s.io/kube-apiserver:v1.34.1 kube-apiserver \
  --etcd-servers=http://127.0.0.1:2379 \
  --service-account-issuer=https://kubernetes.default.svc \
  --service-account-key-file=/work/sa.pub \
  --service-account-signing-key-file=/work/sa.key \
  --token-auth-file=/work/tokens.csv \
  --authorization-mode=RBAC \
  --tls-cert-file=/work/tls.crt --tls-private-key-file=/work/tls.key \
  --service-cluster-ip-range=10.43.0.0/16 \
  --bind-address=127.0.0.1 --secure-port=16443

docker run --rm --network container:etcd-recover --entrypoint kubectl bitnami/kubectl:latest \
  --server=https://127.0.0.1:16443 --token=recover-token --insecure-skip-tls-verify \
  get secret db-creds -n default -o jsonpath='{.data.password}' | base64 -d
```

```text
s3cr3t-from-backup
```

`--network container:etcd-recover` shares the etcd container's loopback, so neither process is reachable from outside. The API server writes some default objects into the scratch etcd as it starts, which does not matter because the data directory is disposable. Never point it at a real etcd member.

## Clean up

```bash
docker rm -f apiserver-recover etcd-recover
rm -rf restore
shred -u snapshot.db raw.bin sa.key tls.key tokens.csv 2>/dev/null
```

## FAQ

### Is there really no way to read the snapshot without restoring it?

Not with etcd's tools. The file is a bbolt database, and bbolt browsers can open it, but keys are stored in etcd's MVCC revision format, which makes finding the latest version of one key tedious. `etcdutl snapshot restore` takes seconds and is the supported path.

### Does this work for ConfigMaps, Deployments and other objects?

Yes. Every resource lives under `/registry/<resource>/<namespace>/<name>` (for example `/registry/configmaps/default/app-config`), and `auger decode` handles built-in types. Custom resources are stored as JSON, so their values are readable without decoding.

### Can I restore just this Secret into the running etcd?

Do not write to the live etcd directly. Apply the decoded YAML through the API server with `kubectl apply`, so admission, encryption and watches all behave normally.

### My cluster encrypts Secrets. Will auger decrypt them?

No. auger decodes protobuf only; an encrypted value has to be decrypted with the key from the API server's encryption config first. The [RKE2 guide](/post/extracting-decrypting-secret-etcd-snapshot-rke2/) shows the openssl steps for `aescbc` and the temporary API server approach, which also works for other providers.

## Related guides

- [Decrypt One Secret From an RKE2 etcd Snapshot](/post/extracting-decrypting-secret-etcd-snapshot-rke2/)
- [Deep Dive into etcd and Kubernetes](/post/deep-dive-etcd-kubernetes/)
- [Monitor an etcd Cluster with Grafana and Prometheus in RKE2](/monitor-etcd-cluster-grafana-prometheus-rke2/)
