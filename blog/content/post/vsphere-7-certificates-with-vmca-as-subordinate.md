+++
Categories = ["VMware", "vCenter", "SSL"]
Tags = ["vmware", "vcenter", "ssl"]
date = "2021-09-07T07:46:00+00:00"
more_link = "yes"
title = "vSphere 7 – Certificates with VMCA as Subordinate"
+++

For enterprises that need fully trusted SSL certificates for the vSphere 7.0 environment, you have two basic options:

Full Custom Mode: Manually replace all certificates for vCenter and the ESXi hosts with your trusted certificates.
Subordinate CA Mode: Use the built-in VMCA service as an official subordinate CA of your existing PKI infrastructure. After the initial configuration, automates the issuing of SSL certs for your vSphere environment. This is the method covered in this blog post.
VMware offers two other certificate options: Fully Managed and hybrid mode, for a total of four certificate options. You can find out more about all of them in this VMware blog post. 
 
In a high-security environment, it is very likely the security team will NOT let you configure the vCenter VMCA as a subordinate CA. So, you will be left with the full custom mode if you want 100% of the certificates trusted. However, if you are in a situation where you can configure the VMCA as a subordinate CA, this post is for you! 
 
Note: Before you do this replacement in production, I strongly urge you to set up a test vCenter instance and run this entire procedure. Botched certificate replacements can lead to bad days. And another tip for a lab test is to snapshot the vCenter VM before you try the process. That way, you can easily roll back should things go south.

<!--more-->
# [Enable SCP on the VCSAs](#enable-scp-on-the-vcsas)

We will be transferring files back and forth from the VCSA, so we need to enable SCP. Run these steps if you don't already have SCP enabled (it's disabled by default).

- SSH into your vCenter 7 appliance as root and run the following commands:

```
shell.set --enable True
shell
chsh -s /bin/bash root
```

# [Generate the Certificate Signing Request (CSR)](#generate-the-csr)

- SSH into your vCenter 7 appliance as root and run the following commands:

```
/usr/lib/vmware-vmca/bin/certificate-manager
```

- Select Option 2.
- Type Y when prompted to generate the certificates using a configuration file.
- Press Enter if using administrator@vsphere.local is OK.
- Input the administrator password when prompted.
- Enter your country code, e.g., US.
- For the Name value, enter the FQDN of your VCSA
- Input your Organization name
- Input your OrgUnit 
- Input your State
- Input your Locality
- Input the IP address of your VCSA
- Input a contact email address
- Input the FQDN of your VCSA for the hostname
- Input the VMCA Name (i.e., FQDN of your VCSA)
- Select option 1 to generate the CSRs
- Enter the path of your choice (e.g.,/tmp/) for the resulting CSRs
- Leave the SSH session open, as we will return to it once we get the certificates minted.

The Certificate manager created two files:

```
/tmp/vmca_issued_csr.csr
/tmp/vmca_issued_key.key
```

# [Download the VMCA Files](#download-the-vmcs-files)

- Open your favorite SCP tool (e.g. WinSCP, FileZilla, etc.).
- Navigate to /tmp/
- Download: `vmca_issued_csr.csr`

# [Signing the Subordinate Certificate](#signing-the-subca)

How you will be minting your Certificate is highly dependent on your PKI infrastructure. In my case, I'm running a two-tier Windows Server 2019 CA. So I'll walk you through that process. The 2019 CA is configured exactly like I've written about in my [Windows Server 2019 Two-Tier PKI CA](TBD) series. Have a look at those three posts if you are in a lab and don't already have a running CA.

# [Configuring the Subordinate Certificate Template](#configuring-subca-template)

If you followed my Windows Server 2019 CA guide, you would need to authorize a new template type so that you can issue a subordinate CA certificate via the CA's web interface.

- Login to your issuing CA and launch the Certification Authority console.
- Expand the tree and click on Certificate Templates, then right-click, select New, and then Certificate Template to Issue.
- Scroll down to Subordinate Certification Authority and click on it.
- Click OK. You should now have a new template type that the CA can issue.

# [Submit Certificate Request](#submit-cert-request)

- Open a browser and go to your Microsoft CA's certificate page (e.g., https://a1wndcp01.ad.support.tools/certsrv/)
  - Click Request a certificate.
  - Click Submit a certificate request by using...
- Open the vmca_issued_csr.CSR file in your favorite text editor.
- Copy and paste the contents into the Saved Request field. 
- Change the certificate template to Subordinate Certification Authority.
- Click Submit.
- Select Base 64 encoded
- Select Download Certificate. You will now have a `certnew.cer` file on your computer.

# [Validating the VMCA Certificate](#validating-vmca-cert)

While going through this procedure in my lab, I ran into a certificate issue as described in [VMware KB 71120](https://kb.vmware.com/s/article/71120): "ERROR certificate-manager 'lstool get-site-id' failed: 1" in the /log/vmware/vmcad/certificate-manager.log. The symptom of this was the VMCA replacement failing at 85% and being unable to roll back. Quite a sticky situation.

Per the KB, VMware does NOT support the Signature Algorithm RSASSA-PSS. I looked at my Certificate, and sure enough, that was my problem. So open the certnew.cer file in Explorer and verify that you are using another signature algorithm, such as sha256RSA. If you have a CA that is issuing certs with the RSASSA-PSS algorithm, check out my blog post on how to change that setting for Microsoft CAs. DO NOT PROCEED if RSASSA-PSS is present. The replacement procedure WILL FAIL. It would be great if VMware validated the certificates better before installing them to head off this issue.

# [Obtaining CA Certificate Chain](#obtaining-ca-chain)

- Login to the online issuing CA, launch a blank MMC console, add the Certificates snap-in and select Computer Account.
- Expand the Intermediate Certification Authorities and click on Certificates.
- Find your offline root CA and Issuing CA certificates.
- Right-click on the offline root and select All Tasks, Export.
- Select Base-64 encoded.
- Browse to your Downloads directory, then enter a file name, e.g., `root.cer`.
- Repeat for the Issuing CA and name it something like `issuing.cer`.
- Create a new file called chain.cer with the content on cert files in the following order.
  - `certnew.cer`
  - `issuing.cer`
  - `root.cer`


# [Configuring the VMCA](#configuring-vmca)

- Transfer chain.cer to the VMCA via SCP to /tmp/.
- Switch back to your SSH session on the VMCA and press 1.
- Enter /tmp/chain.cer for the Root certificate.
- Enter /tmp/vmca_issued_key.key for the custom key.
- Enter Y to replace all of the certificates.
- Sit back and wait a few minutes for the change to complete.
- If the change is successful, you will see a 100% completed status.

# [VMCA Certificate Validation](#verfiy-cert)

- Open your favorite browser and go to the VCSA login page using the FQDN.
- Click on the padlock icon in the URL bar, and view the SSL certificate properties.
- Verify that the Certificate was issued by your VMCA and is fully trusted via your root CA.
- Login to vCenter, go to the Administration page, then select Certificate Management. 
- Review all of the certificates listed to ensure the VMCA issues them.

# [Renewing ESXi Certificates](#renewing-esxi-certs)

Unfortunately, when you configure the VMCA to be a subordinate CA, the process does NOT automatically renew/replace the ESXi host certificates. And, there's another little gotcha too. Suppose you manually renew the ESXi host certificate within 24 hours of configuring your VMCA as a subordinate. In that case, it will fail with an error 70034: A general system error occurred: Unable to get signed Certificate for the host: esxi_hostname. Error: Start Time Error (70034)

To work around this issue, VMware wrote [KB 2123386](https://kb.vmware.com/s/article/2123386), which involves modifying an existing vCenter 7 advanced settings. To change this setting:

- Open vCenter, click on your vCenter server in the tree pane, click on Configure, then Advanced Settings. 
- Click on Edit Settings.
- Click on the funnel in the name column and enter vpxd.cert mgmt.certs.minutesBefore. 
- Change the value from 1440 to 10 and click Save.

# [Updating ESXi Machine Certificate](#updating-esxi-certs)

- Login to vCenter and change to the hosts and clusters view.
- Find your target ESXi server, click Configure, then Certificate.
- Click on RENEW.
- Wait a couple of minutes, and verify the new Certificate shown has the suitable properties. 
- Repeat for all other ESXi hosts.