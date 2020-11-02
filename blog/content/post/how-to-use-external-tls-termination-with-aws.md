+++
Categories = ["Rancher", "AWS"]
Tags = ["rancher", "aws"]
date = "2020-10-23T14:28:00+00:00"
more_link = "yes"
title = "How to use External TLS Termination with AWS"
+++

This document covers setting up Rancher using an AWS SSL certificate and an ALB (Application Load Balancer).

<!--more-->
# [Pre-requisites](#pre-requisites)

- Running Rancher management servers on AWS
- Cluster Admin or higher permissions in Rancher.
- The following permissions in AWS
  - Create/Edit an NLB (Network Load Balancer)
  - Create/Edit an target groups

# [Resolution](#resolution)

## Configure the SSL certificate

- If you are using your own certificate follow the AWS documentation to [import the certificate](https://docs.aws.amazon.com/acm/latest/userguide/import-certificate-api-cli.html).
- If you are using an AWS certificate following the AWS documentation to [request a public ACM certificate](https://docs.aws.amazon.com/acm/latest/userguide/gs-acm-request-public.html).

## Create the Target Group

- Log into the AWS Console to get started.
- Use [Create a Target Group](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-target-group.html) to create a Target group using the data in the tables below to complete the procedure:
  - Target Group Name: rancher-http-80
  - Protocol: http
  - Port: 80
  - Target type: instance
  - VPC: Choose your VPC
  - Protocol (Health Check): http
  - Path (Health Check): /healthz
- Use [Register Targets](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-register-targets.html) to Rancher management servers making sure to use the port 80.

## Create the ALB

- From your web browser, navigate to the [Amazon EC2 Console](https://console.aws.amazon.com/ec2/).
- From the navigation pane, choose LOAD BALANCING > Load Balancers.
- Click Create Load Balancer.
- Choose Application Load Balancer.
- Complete the Step 1: Configure Load Balancer form:
  - Basic Configuration
    - Name: rancher-http
    - Scheme: internet-facing
    - IP address type: ipv4
  - Listeners
    - Add the Load Balancer Protocols and Load Balancer Ports below.
    - HTTP: 80
    - HTTPS: 443
  - Availability Zones
    - Select Your VPC and Availability Zones.
- Complete the Step 2: Configure Security Settings form.
  - Configure the certificate you want to use for SSL termination.
- Complete the Step 3: Configure Security Groups form.
- Complete the Step 4: Configure Routing form.
  - From the Target Group drop-down, choose Existing target group.
  - Add target group rancher-http-80.
- Complete Step 5: Register Targets. Since you registered your targets earlier, all you have to do it click Next: Review.
- Complete Step 6: Review. Look over the load balancer details and click Create when you’re satisfied.
- After AWS creates the ALB, click Close.

### Configure External TLS Termination for Rancher

You need to add the option `--set tls=external` to your Rancher install, per the following example: `helm install rancher rancher-latest/rancher --namespace cattle-system --set hostname=mmattox-example.support.rancher.space --version 2.3.6 --set tls=external`

### Verification

Run the following command to verify new certificate:

```
curl --insecure -v https://<<Rancher Hostname>> 2>&1 | awk 'BEGIN { cert=0 } /^\* SSL connection/ { cert=1 } /^\*/ { if (cert) print }'
```

Example output:

```
* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
* ALPN, server did not agree to a protocol
* Server certificate:
*  subject: OU=Domain Control Validated; CN=*.rancher.tools
*  start date: Jul  2 00:42:01 2019 GMT
*  expire date: May  2 00:19:41 2020 GMT
*  issuer: C=BE; O=GlobalSign nv-sa; CN=AlphaSSL CA - SHA256 - G2
*  SSL certificate verify ok.
* TLSv1.3 (IN), TLS handshake, Newsession Ticket (4):
* TLSv1.3 (IN), TLS handshake, Newsession Ticket (4):
* old SSL session ID is stale, removing
* Mark bundle as not supporting multiuse
* Connection #0 to host mmattox-example.support.rancher.space left intact
```

NOTE: Some browsers will cache the certificate. [Details on how to clear the SSL state in a browser can be found here](a2hosting.com/kb/getting-started-guide/internet-and-networking/clearing-a-web-browsers-ssl-state).
