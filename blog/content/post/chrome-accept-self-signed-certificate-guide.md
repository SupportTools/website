---
title: "How to Get Chrome to Accept a Self-Signed Certificate"
date: 2023-10-13T09:30:00-05:00
draft: false
tags: ["Chrome", "SSL", "Certificate"]
categories:
- Web Browsers
- SSL/TLS
author: "Matthew Mattox - mmattox@support.tools."
description: "A step-by-step guide on making Chrome accept a self-signed certificate."
more_link: "yes"
---

## How to Get Chrome to Accept a Self-Signed Certificate

If you're working with a self-signed certificate and need to make Chrome accept it, here's a step-by-step procedure that works for Chrome 68 on Windows 10. This method allows you to trust the certificate and use it without encountering constant security warnings.

- Navigate to the site with the self-signed certificate you want to trust. You will likely encounter the usual warnings for untrusted certificates. Proceed to the website despite these warnings.

- In the Chrome address bar, right-click on the red warning triangle icon and the "Not secure" message. From the resulting menu, select "Certificate" to display the certificate details.

- In the Certificate Details window that pops up, go to the "Details" tab (located immediately to the right of "General"). Click on the "Copy to File..." button at the bottom right of the tab.

- This action launches the Certificate Export Wizard. Click "Next" at the bottom, which takes you to a dialog where you can select the export format. Leave the default option as "DER encoded binary X.509 (.CER)" and click "Next" again.

- Use the "Browse..." button to choose a filename and location for the exported certificate. Take note of the name and path. Click "Next" to proceed with the export and then click "Finish."

- A pop-up window should confirm that the export was successful. Click "OK" to dismiss it and do the same in the original "Certificate" pop-up window to close it.

- Next, open the Chrome settings page, scroll to the bottom, and expand the "Advanced" section. In the "Privacy and security" panel, click on "Manage certificates."

- In the "Certificates" pop-up window, select the "Trusted Root Certification Authorities" tab. Click on the "Import..." button; this action launches the Certificate Import Wizard.

- Click "Next" and, on the following page, select "Browse..." to locate the certificate you exported in step 5 above using the file explorer.

- Click "Next" again, then "Finish." In the "Security Warning" pop-up, click "Yes." You should see another pop-up confirming the successful import.

- Restart Chrome and revisit the webpage with the self-signed certificate. This time, you should see a closed padlock icon and the "Secure" annotation to the left of the URL, indicating that Chrome now accepts the certificate.
