+++
Categories = ["Certificates", "Linux"]
Tags = ["Certificates", "openssl"]
date = "2019-11-19T20:17:00+00:00"
more_link = "yes"
title = "How to become a local CA, and sign your own SSL certificates"
+++

Sometimes when you experiment with some apps and VMs (like hosting gitlab on a local server or running a Rancher lab cluster) you might want to setup SSL for the app to work, to mimic the live setup and to make the browser happy. In order to do that, you need a SSL certificate.

You can buy one for your domain from a trusted CA, but if you're working on a local network, that might not be possible. The other solution is... becoming CA yourself and issuing and signing the certificate yourself!

It's pretty easy, you need a linux box with openssl installed, then follow these instructions:

![](/images/local-ca/ssl.png)

<!--more-->
[CA part](#ca-part)

To become a CA, you need a key and certificate pair. To create the key, execute:

```
openssl genrsa -des3 -out myCA.key 2048
```

To generate the certificate, execute the following:

```
openssl req -x509 -new -nodes -key myCA.key -sha256 -days 1925 -out myCA.pem
```

That's it! Now after you import the CA certificate to your machine, every certificate signed by it is going to be trusted!

[CRT part](#crt-part)

First thing you need is a private key:

```
openssl genrsa -out rancher.example.com.key 2048
```

Then create the signing request:

```
openssl req -new -key rancher.example.com.key -out rancher.example.com.csr
```

Answer the question asked, one potentially important is the Common Name.

Now to sign it with the CA key and certificate, you need the config file with Subject Alternative Name (SAN) specified.

The config I used comes from here:
```
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = rancher.example.com
```

Now the final command to sign the certificate:
```
openssl x509 -req -in rancher.example.com.csr -CA myCA.pem -CAkey myCA.key -CAcreateserial -out rancher.example.com.crt -days 1825 -sha256 -extfile config.conf
```

Now you should have the working and signed certificate.

[Links & Gotcha's](#link)

why you cannot do TLD wildcard, even with SAN (like *.local)

- https://bugs.chromium.org/p/chromium/issues/detail?id=736715
- https://superuser.com/questions/1305671/san-wildcard-for-whole-domain-tld
- https://www.icann.org/groups/ssac/documents/sac-015-en
- https://security.stackexchange.com/questions/6873/can-a-wildcard-ssl-certificate-be-issued-for-a-second-level-domain

Useful links

- https://deliciousbrains.com/ssl-certificate-authority-for-local-https-development/
- https://stackoverflow.com/questions/10175812/how-to-create-a-self-signed-certificate-with-openssl/27931596#27931596
- https://stackoverflow.com/questions/43665243/invalid-self-signed-ssl-cert-subject-alternative-name-missing/43665244#43665244
- https://unix.stackexchange.com/questions/371997/creating-a-local-ssl-certificate
- http://wiki.cacert.org/FAQ/subjectAltName
- https://geekflare.com/san-ssl-certificate/
- https://gist.github.com/bitoiu/9e19962b991a71165268
- https://blog.zencoffee.org/2013/04/creating-and-signing-an-ssl-cert-with-alternative-names/
- http://grokify.github.io/security/wildcard-subject-alternative-name-ssl-tls-certificates/
- https://stackoverflow.com/questions/1822268/how-do-i-create-my-own-wildcard-certificate-on-linux
