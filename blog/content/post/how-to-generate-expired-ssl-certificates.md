+++
Categories = ["Linux", "openssl"]
Tags = ["linux", "openssl"]
date = "2021-10-21T00:04:00+00:00"
more_link = "yes"
title = "How to generate expired SSL certificates using OpenSSL and Faketime"
+++

While playing with SSL certificates and Kubernetes, I wanted to see how Kubernetes respond when its certificates have expired. Since Rancher/RKE uses self-signed certificates, I was able to play with different configurations. The lowest duration of validity we can give to the certificate is one day. I'm not patient enough to wait for a day to let the certificate expire. So I wanted to find a way to generate certificates that are expired at the time of generation itself.

<!--more-->

I stumbled upon [libfaketime](https://github.com/wolfcw/libfaketime) that worked perfectly for my use case. libfaketime intercepts various system calls from the given program and reports modified date and time. I used the CLI version faketime as it had enough functionalities for my needs.

- Generate the root ca with start time sometime in the past
```
# Generate the private key and self-signed cert for the root CA
faketime 'last week' openssl req -x509 -nodes -sha256 \
    -newkey rsa:2048 -days 365 -out root_ca.crt -keyout root_ca.key \
    -subj "/C=US/ST=IL/O=Rancher, Inc./CN=rancher.support.tools" 
```

- Generate the server certificate and key using the root_ca, but with shorter validity, so it is expired at the time of generation itself.
```
# Generate the CSR for the server
openssl req -new -nodes -newkey rsa:2048 \
    -subj "/C=US/ST=IL/O=Rancher, Inc./CN=10.43.0.1" \
    -out server.csr -keyout server.key

# Generate the certificate signed by the root CA
# The lowest validity is one day. We would have to wait for
# for a day for the certificate to expire. Instead, use
# faketime to generate cert with validity starting
# from the date specified in faketime
faketime '3 days ago' openssl x509 -req -sha256 -days 1 \
    -in server.csr -CA root_ca.crt -CAkey root_ca.key \
    -CAcreateserial -out server.crt
```

Check the certificate expiration dates using openssl x509. The root_ca is set to start from a week ago and expire one year from the start date. The server certificate is set to start three days and expires two days ago.
```
generate-expired-certs % openssl x509 -noout -startdate -enddate -in root_ca.crt
notBefore=Oct 11 21:51:20 2021 GMT
notAfter=Oct 11 21:51:20 2022 GMT

generate-expired-certs % openssl x509 -noout -startdate -enddate -in server.crt
notBefore=Oct 15 21:51:20 2021 GMT
notAfter=Oct 16 21:51:20 2021 GMT
```