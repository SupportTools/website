---
title: "Enterprise ESXi OEM Image Management: Automated Deployment Infrastructure and Comprehensive Driver Integration Framework"
date: 2025-07-15T10:00:00-05:00
draft: false
tags: ["ESXi", "VMware", "OEM Images", "Driver Management", "vSphere", "Automation", "Infrastructure as Code", "Enterprise Deployment", "Broadcom", "DevOps"]
categories:
- Virtualization
- Enterprise Infrastructure
- Automation
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete enterprise guide to ESXi OEM image management, automated ISO discovery and deployment, comprehensive driver integration frameworks, and production-scale virtualization infrastructure"
more_link: "yes"
url: "/enterprise-esxi-oem-image-management-automated-deployment-infrastructure/"
---

Enterprise ESXi deployments require sophisticated OEM image management systems, automated driver integration pipelines, and comprehensive deployment frameworks to ensure consistent infrastructure provisioning across diverse hardware platforms at scale. This guide covers advanced ESXi image discovery automation, enterprise OEM ISO management, production deployment pipelines, and comprehensive driver integration strategies for global virtualization infrastructures.

<!--more-->

# [Enterprise ESXi Image Management Architecture](#enterprise-esxi-image-management-architecture)

## OEM Image Lifecycle Strategy

Enterprise virtualization infrastructures demand automated image management across multiple hardware vendors, driver versions, and deployment scenarios while maintaining compliance, security, and operational efficiency at scale.

### Enterprise ESXi Image Management Framework

```
┌─────────────────────────────────────────────────────────────────┐
│             Enterprise ESXi Image Management System             │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│  Source Layer   │  Processing     │  Distribution   │ Deployment│
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ Broadcom    │ │ │ Driver Inject│ │ │ Image Repo  │ │ │ PXE   │ │
│ │ Portal      │ │ │ Customization│ │ │ Version Ctrl│ │ │ Auto  │ │
│ │ OEM Sites   │ │ │ Validation   │ │ │ Distribution│ │ │ Deploy│ │
│ │ VMware Depot│ │ │ Signing      │ │ │ Caching     │ │ │ GitOps│ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ • Multi-vendor  │ • Automated     │ • Global CDN    │ • Zero    │
│ • Version track │ • Compliance    │ • Geo-replicate │ • Touch   │
│ • API access    │ • Security scan │ • HA storage    │ • Scale   │
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### ESXi Image Management Maturity Model

| Level | Image Source | Driver Management | Deployment | Scale |
|-------|--------------|-------------------|------------|--------|
| **Manual** | Portal downloads | Manual injection | USB/DVD | 10s |
| **Scripted** | CLI automation | Script-based | Network boot | 100s |
| **Automated** | API integration | Pipeline-driven | Auto Deploy | 1000s |
| **Enterprise** | Full automation | AI-optimized | GitOps/IaC | 10000s+ |

## Advanced ESXi Image Discovery Framework

### Enterprise OEM Image Management System

```python
#!/usr/bin/env python3
"""
Enterprise ESXi OEM Image Discovery and Management Framework
"""

import os
import sys
import json
import yaml
import logging
import asyncio
import aiohttp
import hashlib
import re
from typing import Dict, List, Optional, Tuple, Any, Union, Set
from dataclasses import dataclass, asdict, field
from pathlib import Path
from enum import Enum
from datetime import datetime, timedelta
import urllib.parse
from bs4 import BeautifulSoup
import requests
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import boto3
from azure.storage.blob import BlobServiceClient
import paramiko
from prometheus_client import Counter, Gauge, Histogram
import redis
from sqlalchemy import create_engine, Column, String, DateTime, Integer, Boolean
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

Base = declarative_base()

class ImageType(Enum):
    STANDARD = "standard"
    OEM = "oem"
    CUSTOM = "custom"
    OFFLINE_BUNDLE = "offline_bundle"

class VendorType(Enum):
    DELL = "dell"
    HPE = "hpe"
    LENOVO = "lenovo"
    CISCO = "cisco"
    FUJITSU = "fujitsu"
    SUPERMICRO = "supermicro"
    GENERIC = "generic"

class DeploymentMethod(Enum):
    ISO = "iso"
    PXE = "pxe"
    AUTO_DEPLOY = "auto_deploy"
    USB = "usb"
    UEFI_HTTP = "uefi_http"

@dataclass
class ESXiImage:
    """ESXi image metadata structure"""
    image_id: str
    name: str
    version: str
    build_number: str
    vendor: VendorType
    image_type: ImageType
    release_date: datetime
    file_size: int
    checksum: str
    download_url: str
    driver_versions: Dict[str, str]
    supported_hardware: List[str]
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class DownloadCredentials:
    """Credentials for various download portals"""
    broadcom_username: str
    broadcom_password: str
    dell_api_key: Optional[str] = None
    hpe_api_key: Optional[str] = None
    lenovo_credentials: Optional[Dict[str, str]] = None

class ESXiImageDB(Base):
    """Database model for ESXi images"""
    __tablename__ = 'esxi_images'
    
    image_id = Column(String, primary_key=True)
    name = Column(String)
    version = Column(String)
    build_number = Column(String)
    vendor = Column(String)
    image_type = Column(String)
    release_date = Column(DateTime)
    file_size = Column(Integer)
    checksum = Column(String)
    download_url = Column(String)
    driver_versions = Column(String)  # JSON
    supported_hardware = Column(String)  # JSON
    metadata = Column(String)  # JSON
    discovered_at = Column(DateTime, default=datetime.utcnow)
    downloaded = Column(Boolean, default=False)
    validated = Column(Boolean, default=False)

class EnterpriseESXiImageManager:
    """Enterprise ESXi image discovery and management system"""
    
    def __init__(self, config_path: str):
        self.config = self._load_config(config_path)
        self.logger = self._setup_logging()
        self.credentials = self._load_credentials()
        self.session = aiohttp.ClientSession()
        self.db_engine = create_engine(self.config['database_url'])
        Base.metadata.create_all(self.db_engine)
        self.db_session = sessionmaker(bind=self.db_engine)
        self.redis_client = redis.Redis(
            host=self.config.get('redis_host', 'localhost'),
            port=self.config.get('redis_port', 6379)
        )
        
        # Storage backends
        self.s3_client = self._init_s3() if self.config.get('s3_enabled') else None
        self.azure_client = self._init_azure() if self.config.get('azure_enabled') else None
        
        # Metrics
        self.images_discovered = Counter('esxi_images_discovered_total',
                                       'Total ESXi images discovered',
                                       ['vendor', 'type'])
        self.downloads_completed = Counter('esxi_downloads_completed_total',
                                         'Total ESXi image downloads',
                                         ['vendor', 'status'])
        self.image_age_days = Gauge('esxi_image_age_days',
                                  'Age of ESXi images in days',
                                  ['vendor', 'version'])
    
    def _load_config(self, config_path: str) -> Dict[str, Any]:
        """Load configuration from file"""
        with open(config_path, 'r') as f:
            return yaml.safe_load(f)
    
    def _setup_logging(self) -> logging.Logger:
        """Setup enterprise logging"""
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        
        # Console handler
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.INFO)
        
        # File handler
        file_handler = logging.FileHandler(
            f"/var/log/esxi-image-manager-{datetime.now().strftime('%Y%m%d')}.log"
        )
        file_handler.setLevel(logging.DEBUG)
        
        # Formatter
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        
        for handler in [console_handler, file_handler]:
            handler.setFormatter(formatter)
            logger.addHandler(handler)
        
        return logger
    
    def _load_credentials(self) -> DownloadCredentials:
        """Load download portal credentials"""
        cred_file = self.config.get('credentials_file', '/etc/esxi-manager/credentials.yaml')
        
        with open(cred_file, 'r') as f:
            creds = yaml.safe_load(f)
        
        return DownloadCredentials(
            broadcom_username=creds['broadcom']['username'],
            broadcom_password=creds['broadcom']['password'],
            dell_api_key=creds.get('dell', {}).get('api_key'),
            hpe_api_key=creds.get('hpe', {}).get('api_key'),
            lenovo_credentials=creds.get('lenovo')
        )
    
    def _init_s3(self) -> boto3.client:
        """Initialize S3 client"""
        return boto3.client(
            's3',
            aws_access_key_id=self.config['s3']['access_key'],
            aws_secret_access_key=self.config['s3']['secret_key'],
            region_name=self.config['s3']['region']
        )
    
    def _init_azure(self) -> BlobServiceClient:
        """Initialize Azure Blob Storage client"""
        return BlobServiceClient(
            account_url=self.config['azure']['account_url'],
            credential=self.config['azure']['credential']
        )
    
    async def discover_broadcom_images(self) -> List[ESXiImage]:
        """Discover ESXi images from Broadcom portal"""
        self.logger.info("Starting Broadcom portal discovery")
        images = []
        
        # Setup Selenium for portal navigation
        options = webdriver.ChromeOptions()
        options.add_argument('--headless')
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        
        driver = webdriver.Chrome(options=options)
        
        try:
            # Login to Broadcom portal
            driver.get(self.config['broadcom_portal_url'])
            
            # Wait for login form
            wait = WebDriverWait(driver, 10)
            username_field = wait.until(
                EC.presence_of_element_located((By.ID, "username"))
            )
            password_field = driver.find_element(By.ID, "password")
            
            # Enter credentials
            username_field.send_keys(self.credentials.broadcom_username)
            password_field.send_keys(self.credentials.broadcom_password)
            
            # Submit login
            login_button = driver.find_element(By.ID, "login-button")
            login_button.click()
            
            # Navigate to VMware Cloud Foundation section
            wait.until(EC.presence_of_element_located((By.CLASS_NAME, "cloud-icon")))
            cloud_icon = driver.find_element(By.CLASS_NAME, "cloud-icon")
            cloud_icon.click()
            
            # Select VMware Cloud Foundation
            vcf_option = wait.until(
                EC.element_to_be_clickable((By.XPATH, "//a[contains(text(), 'VMware Cloud Foundation')]"))
            )
            vcf_option.click()
            
            # Navigate to My Downloads
            downloads_link = wait.until(
                EC.element_to_be_clickable((By.XPATH, "//a[contains(text(), 'My Downloads')]"))
            )
            downloads_link.click()
            
            # Search for VMware vSphere
            search_box = wait.until(
                EC.presence_of_element_located((By.CLASS_NAME, "search-input"))
            )
            search_box.send_keys("VMware vSphere")
            search_box.submit()
            
            # Select vSphere from results
            vsphere_link = wait.until(
                EC.element_to_be_clickable((By.XPATH, "//a[contains(text(), 'VMware vSphere')]"))
            )
            vsphere_link.click()
            
            # Navigate to ESXi section
            esxi_tab = wait.until(
                EC.element_to_be_clickable((By.XPATH, "//a[contains(text(), 'ESXi')]"))
            )
            esxi_tab.click()
            
            # Navigate to Custom ISOs tab
            custom_isos_tab = wait.until(
                EC.element_to_be_clickable((By.XPATH, "//a[contains(text(), 'Custom ISOs')]"))
            )
            custom_isos_tab.click()
            
            # Parse available ISOs
            iso_elements = driver.find_elements(By.CLASS_NAME, "download-item")
            
            for element in iso_elements:
                try:
                    # Extract image information
                    name = element.find_element(By.CLASS_NAME, "item-name").text
                    version_match = re.search(r'(\d+\.\d+(?:\.\d+)?)', name)
                    vendor = self._identify_vendor(name)
                    
                    # Get download link
                    download_link = element.find_element(By.CLASS_NAME, "download-link")
                    download_url = download_link.get_attribute('href')
                    
                    # Get file size
                    size_text = element.find_element(By.CLASS_NAME, "file-size").text
                    file_size = self._parse_file_size(size_text)
                    
                    # Create image object
                    image = ESXiImage(
                        image_id=hashlib.sha256(name.encode()).hexdigest()[:16],
                        name=name,
                        version=version_match.group(1) if version_match else "Unknown",
                        build_number=self._extract_build_number(name),
                        vendor=vendor,
                        image_type=ImageType.OEM,
                        release_date=datetime.now(),  # Would need to parse from page
                        file_size=file_size,
                        checksum="",  # Would need to fetch separately
                        download_url=download_url,
                        driver_versions=self._extract_driver_versions(name),
                        supported_hardware=self._get_supported_hardware(vendor),
                        metadata={
                            'source': 'broadcom_portal',
                            'discovered_method': 'selenium'
                        }
                    )
                    
                    images.append(image)
                    self.images_discovered.labels(
                        vendor=vendor.value,
                        type=ImageType.OEM.value
                    ).inc()
                    
                except Exception as e:
                    self.logger.error(f"Error parsing ISO element: {e}")
                    continue
            
        except Exception as e:
            self.logger.error(f"Broadcom portal discovery error: {e}")
        finally:
            driver.quit()
        
        self.logger.info(f"Discovered {len(images)} images from Broadcom portal")
        return images
    
    def _identify_vendor(self, name: str) -> VendorType:
        """Identify vendor from image name"""
        name_lower = name.lower()
        
        vendor_patterns = {
            VendorType.DELL: ['dell', 'poweredge'],
            VendorType.HPE: ['hpe', 'proliant', 'synergy'],
            VendorType.LENOVO: ['lenovo', 'thinksystem'],
            VendorType.CISCO: ['cisco', 'ucs'],
            VendorType.FUJITSU: ['fujitsu', 'primergy'],
            VendorType.SUPERMICRO: ['supermicro', 'superserver']
        }
        
        for vendor, patterns in vendor_patterns.items():
            if any(pattern in name_lower for pattern in patterns):
                return vendor
        
        return VendorType.GENERIC
    
    def _parse_file_size(self, size_text: str) -> int:
        """Parse file size from text"""
        size_match = re.search(r'([\d.]+)\s*([KMGT]B)', size_text, re.IGNORECASE)
        if not size_match:
            return 0
        
        value = float(size_match.group(1))
        unit = size_match.group(2).upper()
        
        multipliers = {
            'KB': 1024,
            'MB': 1024 ** 2,
            'GB': 1024 ** 3,
            'TB': 1024 ** 4
        }
        
        return int(value * multipliers.get(unit, 1))
    
    def _extract_build_number(self, name: str) -> str:
        """Extract build number from image name"""
        build_match = re.search(r'(\d{7,})', name)
        return build_match.group(1) if build_match else "Unknown"
    
    def _extract_driver_versions(self, name: str) -> Dict[str, str]:
        """Extract driver versions from image name"""
        drivers = {}
        
        # Common driver patterns
        patterns = {
            'async': r'async[_-]?(\d+\.\d+\.\d+)',
            'nenic': r'nenic[_-]?(\d+\.\d+\.\d+)',
            'nfnic': r'nfnic[_-]?(\d+\.\d+\.\d+)',
            'nhpsa': r'nhpsa[_-]?(\d+\.\d+\.\d+)',
            'qlnativefc': r'qlnativefc[_-]?(\d+\.\d+\.\d+)'
        }
        
        for driver, pattern in patterns.items():
            match = re.search(pattern, name, re.IGNORECASE)
            if match:
                drivers[driver] = match.group(1)
        
        return drivers
    
    def _get_supported_hardware(self, vendor: VendorType) -> List[str]:
        """Get supported hardware models for vendor"""
        hardware_map = {
            VendorType.DELL: [
                "PowerEdge R640", "PowerEdge R740", "PowerEdge R740xd",
                "PowerEdge R840", "PowerEdge R940", "PowerEdge R6525",
                "PowerEdge R7525", "PowerEdge R650", "PowerEdge R750"
            ],
            VendorType.HPE: [
                "ProLiant DL360 Gen10", "ProLiant DL380 Gen10",
                "ProLiant DL580 Gen10", "Synergy 480 Gen10",
                "ProLiant DL325 Gen10 Plus", "ProLiant DL385 Gen10 Plus"
            ],
            VendorType.LENOVO: [
                "ThinkSystem SR630", "ThinkSystem SR650",
                "ThinkSystem SR670", "ThinkSystem SR860",
                "ThinkSystem SR645", "ThinkSystem SR665"
            ],
            VendorType.CISCO: [
                "UCS B200 M5", "UCS B480 M5", "UCS C220 M5",
                "UCS C240 M5", "UCS C480 M5", "UCS X210c M6"
            ]
        }
        
        return hardware_map.get(vendor, ["Generic x86_64 hardware"])
    
    async def discover_vendor_images(self, vendor: VendorType) -> List[ESXiImage]:
        """Discover images from vendor-specific sources"""
        self.logger.info(f"Discovering images for vendor: {vendor.value}")
        
        vendor_methods = {
            VendorType.DELL: self._discover_dell_images,
            VendorType.HPE: self._discover_hpe_images,
            VendorType.LENOVO: self._discover_lenovo_images,
            VendorType.CISCO: self._discover_cisco_images
        }
        
        method = vendor_methods.get(vendor)
        if method:
            return await method()
        
        return []
    
    async def _discover_dell_images(self) -> List[ESXiImage]:
        """Discover Dell-specific ESXi images"""
        images = []
        
        if not self.credentials.dell_api_key:
            self.logger.warning("Dell API key not configured")
            return images
        
        headers = {
            'API-Key': self.credentials.dell_api_key,
            'Accept': 'application/json'
        }
        
        try:
            # Query Dell API for ESXi images
            async with self.session.get(
                f"{self.config['dell_api_url']}/catalog/software",
                headers=headers,
                params={
                    'category': 'enterprise-solutions-software',
                    'subcategory': 'ent-solutions-ent-software',
                    'product': 'vmware-esxi'
                }
            ) as response:
                if response.status == 200:
                    data = await response.json()
                    
                    for item in data.get('items', []):
                        if 'esxi' in item.get('name', '').lower():
                            image = ESXiImage(
                                image_id=item.get('id', ''),
                                name=item.get('name', ''),
                                version=item.get('version', ''),
                                build_number=item.get('build', ''),
                                vendor=VendorType.DELL,
                                image_type=ImageType.OEM,
                                release_date=datetime.fromisoformat(
                                    item.get('releaseDate', datetime.now().isoformat())
                                ),
                                file_size=item.get('fileSize', 0),
                                checksum=item.get('checksum', ''),
                                download_url=item.get('downloadUrl', ''),
                                driver_versions=item.get('drivers', {}),
                                supported_hardware=item.get('supportedModels', []),
                                metadata={
                                    'source': 'dell_api',
                                    'part_number': item.get('partNumber', '')
                                }
                            )
                            images.append(image)
        
        except Exception as e:
            self.logger.error(f"Dell API discovery error: {e}")
        
        return images
    
    async def download_image(self, image: ESXiImage, destination: Path) -> bool:
        """Download ESXi image with resume support"""
        self.logger.info(f"Downloading image: {image.name}")
        
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        
        # Check if partially downloaded
        resume_pos = 0
        if destination.exists():
            resume_pos = destination.stat().st_size
            self.logger.info(f"Resuming download from {resume_pos} bytes")
        
        headers = {}
        if resume_pos > 0:
            headers['Range'] = f'bytes={resume_pos}-'
        
        try:
            async with self.session.get(
                image.download_url,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=3600)
            ) as response:
                if response.status not in [200, 206]:
                    self.logger.error(f"Download failed: HTTP {response.status}")
                    return False
                
                # Get total size
                total_size = int(response.headers.get('Content-Length', 0))
                if response.status == 206:
                    total_size += resume_pos
                
                # Download with progress tracking
                mode = 'ab' if resume_pos > 0 else 'wb'
                with open(destination, mode) as f:
                    downloaded = resume_pos
                    async for chunk in response.content.iter_chunked(8192):
                        f.write(chunk)
                        downloaded += len(chunk)
                        
                        # Progress update
                        if total_size > 0:
                            progress = (downloaded / total_size) * 100
                            if downloaded % (1024 * 1024 * 10) == 0:  # Every 10MB
                                self.logger.info(
                                    f"Download progress: {progress:.1f}% "
                                    f"({downloaded / (1024**3):.1f}GB / "
                                    f"{total_size / (1024**3):.1f}GB)"
                                )
                
                # Verify checksum if available
                if image.checksum:
                    if not await self._verify_checksum(destination, image.checksum):
                        self.logger.error("Checksum verification failed")
                        destination.unlink()
                        return False
                
                # Upload to storage backends
                await self._upload_to_storage(image, destination)
                
                # Update database
                self._update_image_status(image.image_id, downloaded=True)
                
                self.downloads_completed.labels(
                    vendor=image.vendor.value,
                    status='success'
                ).inc()
                
                self.logger.info(f"Successfully downloaded: {image.name}")
                return True
                
        except Exception as e:
            self.logger.error(f"Download error: {e}")
            self.downloads_completed.labels(
                vendor=image.vendor.value,
                status='failure'
            ).inc()
            return False
    
    async def _verify_checksum(self, file_path: Path, expected_checksum: str) -> bool:
        """Verify file checksum"""
        self.logger.info("Verifying checksum")
        
        # Determine hash algorithm from checksum length
        checksum_len = len(expected_checksum)
        if checksum_len == 32:
            hash_algo = hashlib.md5()
        elif checksum_len == 40:
            hash_algo = hashlib.sha1()
        elif checksum_len == 64:
            hash_algo = hashlib.sha256()
        else:
            self.logger.warning(f"Unknown checksum format: {checksum_len} chars")
            return True
        
        # Calculate checksum
        with open(file_path, 'rb') as f:
            while chunk := f.read(8192):
                hash_algo.update(chunk)
        
        calculated = hash_algo.hexdigest()
        
        if calculated.lower() == expected_checksum.lower():
            self.logger.info("Checksum verification passed")
            return True
        else:
            self.logger.error(
                f"Checksum mismatch: expected {expected_checksum}, "
                f"got {calculated}"
            )
            return False
    
    async def _upload_to_storage(self, image: ESXiImage, file_path: Path):
        """Upload image to configured storage backends"""
        # Upload to S3
        if self.s3_client:
            try:
                s3_key = f"esxi-images/{image.vendor.value}/{image.version}/{file_path.name}"
                self.s3_client.upload_file(
                    str(file_path),
                    self.config['s3']['bucket'],
                    s3_key,
                    ExtraArgs={
                        'Metadata': {
                            'vendor': image.vendor.value,
                            'version': image.version,
                            'build': image.build_number,
                            'image_type': image.image_type.value
                        }
                    }
                )
                self.logger.info(f"Uploaded to S3: {s3_key}")
            except Exception as e:
                self.logger.error(f"S3 upload error: {e}")
        
        # Upload to Azure
        if self.azure_client:
            try:
                container_name = self.config['azure']['container']
                blob_name = f"esxi-images/{image.vendor.value}/{image.version}/{file_path.name}"
                
                blob_client = self.azure_client.get_blob_client(
                    container=container_name,
                    blob=blob_name
                )
                
                with open(file_path, 'rb') as data:
                    blob_client.upload_blob(
                        data,
                        overwrite=True,
                        metadata={
                            'vendor': image.vendor.value,
                            'version': image.version,
                            'build': image.build_number,
                            'image_type': image.image_type.value
                        }
                    )
                
                self.logger.info(f"Uploaded to Azure: {blob_name}")
            except Exception as e:
                self.logger.error(f"Azure upload error: {e}")
    
    def _update_image_status(self, image_id: str, **kwargs):
        """Update image status in database"""
        session = self.db_session()
        try:
            image_db = session.query(ESXiImageDB).filter_by(
                image_id=image_id
            ).first()
            
            if image_db:
                for key, value in kwargs.items():
                    setattr(image_db, key, value)
                session.commit()
        finally:
            session.close()
    
    async def create_custom_image(self, 
                                base_image: ESXiImage,
                                vibs: List[str],
                                remove_vibs: List[str] = None) -> ESXiImage:
        """Create custom ESXi image with additional VIBs"""
        self.logger.info(f"Creating custom image based on: {base_image.name}")
        
        # Generate custom image ID
        vib_hash = hashlib.sha256(''.join(vibs).encode()).hexdigest()[:8]
        custom_id = f"{base_image.image_id}-custom-{vib_hash}"
        
        # Create PowerCLI script for image customization
        script_content = f"""
# ESXi Image Customization Script
# Generated: {datetime.now().isoformat()}

# Import required modules
Import-Module VMware.ImageBuilder

# Add base image depot
Add-EsxSoftwareDepot "{base_image.download_url}"

# Get base image profile
$baseProfile = Get-EsxImageProfile -Name "{base_image.name}"

# Clone to create custom profile
$customProfile = New-EsxImageProfile -CloneProfile $baseProfile `
    -Name "custom-{base_image.name}-{vib_hash}" `
    -Vendor "Enterprise" `
    -Description "Customized ESXi image with additional VIBs"

# Add custom VIBs
"""
        
        for vib in vibs:
            script_content += f'Add-EsxSoftwarePackage -ImageProfile $customProfile -SoftwarePackage "{vib}"\n'
        
        if remove_vibs:
            for vib in remove_vibs:
                script_content += f'Remove-EsxSoftwarePackage -ImageProfile $customProfile -SoftwarePackage "{vib}"\n'
        
        script_content += """
# Validate image profile
$validation = $customProfile | Test-EsxImageProfile
if ($validation.Succeeded -eq $false) {
    Write-Error "Image validation failed"
    exit 1
}

# Export custom image
Export-EsxImageProfile -ImageProfile $customProfile -ExportToISO `
    -FilePath "./custom-esxi.iso" -Force

# Export as offline bundle
Export-EsxImageProfile -ImageProfile $customProfile -ExportToBundle `
    -FilePath "./custom-esxi.zip" -Force

# Generate checksums
Get-FileHash -Path "./custom-esxi.iso" -Algorithm SHA256 | `
    Select-Object -ExpandProperty Hash | `
    Out-File "./custom-esxi.iso.sha256"
"""
        
        # Execute customization
        script_path = Path(f"/tmp/customize-{custom_id}.ps1")
        script_path.write_text(script_content)
        
        try:
            # Run PowerCLI script
            result = await asyncio.create_subprocess_exec(
                'pwsh', '-File', str(script_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await result.communicate()
            
            if result.returncode != 0:
                self.logger.error(f"Customization failed: {stderr.decode()}")
                raise RuntimeError("Image customization failed")
            
            # Read generated checksum
            checksum_path = Path("./custom-esxi.iso.sha256")
            checksum = checksum_path.read_text().strip()
            
            # Create custom image object
            custom_image = ESXiImage(
                image_id=custom_id,
                name=f"custom-{base_image.name}-{vib_hash}",
                version=base_image.version,
                build_number=base_image.build_number,
                vendor=base_image.vendor,
                image_type=ImageType.CUSTOM,
                release_date=datetime.now(),
                file_size=Path("./custom-esxi.iso").stat().st_size,
                checksum=checksum,
                download_url=f"file://./custom-esxi.iso",
                driver_versions=base_image.driver_versions.copy(),
                supported_hardware=base_image.supported_hardware.copy(),
                metadata={
                    'base_image': base_image.image_id,
                    'added_vibs': vibs,
                    'removed_vibs': remove_vibs or [],
                    'customization_date': datetime.now().isoformat()
                }
            )
            
            # Store in database
            self._store_image(custom_image)
            
            self.logger.info(f"Successfully created custom image: {custom_id}")
            return custom_image
            
        except Exception as e:
            self.logger.error(f"Custom image creation error: {e}")
            raise
        finally:
            # Cleanup
            script_path.unlink(missing_ok=True)
    
    def _store_image(self, image: ESXiImage):
        """Store image in database"""
        session = self.db_session()
        try:
            image_db = ESXiImageDB(
                image_id=image.image_id,
                name=image.name,
                version=image.version,
                build_number=image.build_number,
                vendor=image.vendor.value,
                image_type=image.image_type.value,
                release_date=image.release_date,
                file_size=image.file_size,
                checksum=image.checksum,
                download_url=image.download_url,
                driver_versions=json.dumps(image.driver_versions),
                supported_hardware=json.dumps(image.supported_hardware),
                metadata=json.dumps(image.metadata)
            )
            
            session.merge(image_db)
            session.commit()
        finally:
            session.close()
    
    async def sync_all_sources(self):
        """Sync images from all configured sources"""
        self.logger.info("Starting full image sync")
        
        all_images = []
        
        # Discover from Broadcom portal
        try:
            broadcom_images = await self.discover_broadcom_images()
            all_images.extend(broadcom_images)
        except Exception as e:
            self.logger.error(f"Broadcom sync error: {e}")
        
        # Discover from vendor sources
        for vendor in VendorType:
            if vendor != VendorType.GENERIC:
                try:
                    vendor_images = await self.discover_vendor_images(vendor)
                    all_images.extend(vendor_images)
                except Exception as e:
                    self.logger.error(f"{vendor.value} sync error: {e}")
        
        # Store all discovered images
        for image in all_images:
            self._store_image(image)
            
            # Update metrics
            if image.release_date:
                age_days = (datetime.now() - image.release_date).days
                self.image_age_days.labels(
                    vendor=image.vendor.value,
                    version=image.version
                ).set(age_days)
        
        self.logger.info(f"Sync completed. Discovered {len(all_images)} images")
        
        # Cache results
        self.redis_client.setex(
            'esxi_images:last_sync',
            timedelta(hours=1),
            json.dumps({
                'timestamp': datetime.now().isoformat(),
                'image_count': len(all_images),
                'vendors': list(set(img.vendor.value for img in all_images))
            })
        )
        
        return all_images
    
    async def get_latest_image(self, 
                             vendor: VendorType,
                             version_prefix: Optional[str] = None) -> Optional[ESXiImage]:
        """Get latest ESXi image for vendor"""
        session = self.db_session()
        try:
            query = session.query(ESXiImageDB).filter_by(
                vendor=vendor.value
            )
            
            if version_prefix:
                query = query.filter(
                    ESXiImageDB.version.like(f"{version_prefix}%")
                )
            
            # Order by version and release date
            latest = query.order_by(
                ESXiImageDB.version.desc(),
                ESXiImageDB.release_date.desc()
            ).first()
            
            if latest:
                return self._db_to_image(latest)
            
            return None
            
        finally:
            session.close()
    
    def _db_to_image(self, db_image: ESXiImageDB) -> ESXiImage:
        """Convert database object to ESXiImage"""
        return ESXiImage(
            image_id=db_image.image_id,
            name=db_image.name,
            version=db_image.version,
            build_number=db_image.build_number,
            vendor=VendorType(db_image.vendor),
            image_type=ImageType(db_image.image_type),
            release_date=db_image.release_date,
            file_size=db_image.file_size,
            checksum=db_image.checksum,
            download_url=db_image.download_url,
            driver_versions=json.loads(db_image.driver_versions),
            supported_hardware=json.loads(db_image.supported_hardware),
            metadata=json.loads(db_image.metadata)
        )


class ESXiDeploymentAutomation:
    """Automated ESXi deployment system"""
    
    def __init__(self, image_manager: EnterpriseESXiImageManager):
        self.image_manager = image_manager
        self.logger = logging.getLogger(__name__)
    
    async def create_deployment_package(self,
                                      target_hardware: str,
                                      esxi_version: str,
                                      custom_vibs: List[str] = None) -> Dict[str, Any]:
        """Create deployment package for specific hardware"""
        self.logger.info(f"Creating deployment package for {target_hardware}")
        
        # Determine vendor from hardware model
        vendor = self._determine_vendor(target_hardware)
        
        # Get appropriate image
        image = await self.image_manager.get_latest_image(vendor, esxi_version)
        if not image:
            raise ValueError(f"No image found for {vendor.value} {esxi_version}")
        
        # Check if hardware is supported
        if target_hardware not in image.supported_hardware:
            self.logger.warning(f"{target_hardware} not in supported hardware list")
        
        # Create custom image if VIBs specified
        if custom_vibs:
            image = await self.image_manager.create_custom_image(
                image,
                custom_vibs
            )
        
        # Generate deployment configuration
        deployment_config = {
            'image': asdict(image),
            'target_hardware': target_hardware,
            'deployment_method': DeploymentMethod.AUTO_DEPLOY.value,
            'network_config': self._generate_network_config(target_hardware),
            'storage_config': self._generate_storage_config(target_hardware),
            'host_profile': self._generate_host_profile(target_hardware),
            'post_install_scripts': self._generate_post_install_scripts()
        }
        
        # Create kickstart file
        kickstart = self._generate_kickstart(deployment_config)
        
        # Package everything
        package = {
            'package_id': hashlib.sha256(
                f"{image.image_id}-{target_hardware}".encode()
            ).hexdigest()[:16],
            'created_at': datetime.now().isoformat(),
            'image': image,
            'deployment_config': deployment_config,
            'kickstart': kickstart,
            'estimated_deployment_time': self._estimate_deployment_time(image)
        }
        
        return package
    
    def _determine_vendor(self, hardware_model: str) -> VendorType:
        """Determine vendor from hardware model"""
        model_lower = hardware_model.lower()
        
        if 'poweredge' in model_lower:
            return VendorType.DELL
        elif 'proliant' in model_lower or 'synergy' in model_lower:
            return VendorType.HPE
        elif 'thinksystem' in model_lower:
            return VendorType.LENOVO
        elif 'ucs' in model_lower:
            return VendorType.CISCO
        
        return VendorType.GENERIC
    
    def _generate_network_config(self, hardware: str) -> Dict[str, Any]:
        """Generate network configuration for hardware"""
        return {
            'management': {
                'vlan': 10,
                'subnet': '10.0.10.0/24',
                'mtu': 1500
            },
            'vmotion': {
                'vlan': 20,
                'subnet': '10.0.20.0/24',
                'mtu': 9000
            },
            'vsan': {
                'vlan': 30,
                'subnet': '10.0.30.0/24',
                'mtu': 9000
            },
            'vm_network': {
                'vlans': [100, 101, 102],
                'trunk': True
            }
        }
    
    def _generate_storage_config(self, hardware: str) -> Dict[str, Any]:
        """Generate storage configuration"""
        return {
            'boot_device': '/dev/sda',
            'datastore': {
                'name': 'local-datastore',
                'type': 'VMFS',
                'device': '/dev/sdb'
            },
            'vsan': {
                'enabled': True,
                'cache_tier': ['/dev/nvme0n1', '/dev/nvme1n1'],
                'capacity_tier': ['/dev/sdc', '/dev/sdd', '/dev/sde', '/dev/sdf']
            }
        }
    
    def _generate_host_profile(self, hardware: str) -> Dict[str, Any]:
        """Generate host profile configuration"""
        return {
            'name': f'{hardware}-profile',
            'description': f'Host profile for {hardware}',
            'settings': {
                'security': {
                    'lockdown_mode': 'normal',
                    'ssh_enabled': True,
                    'shell_timeout': 3600
                },
                'advanced': {
                    'UserVars.SuppressShellWarning': 1,
                    'Net.TcpipHeapSize': 32,
                    'Net.TcpipHeapMax': 1536
                },
                'ntp': {
                    'servers': ['ntp1.example.com', 'ntp2.example.com']
                },
                'syslog': {
                    'host': 'syslog.example.com',
                    'port': 514,
                    'protocol': 'tcp'
                }
            }
        }
    
    def _generate_post_install_scripts(self) -> List[str]:
        """Generate post-installation scripts"""
        return [
            """
            # Configure additional settings
            esxcli system settings advanced set -o /Net/NetVMTxType -i 1
            esxcli system settings advanced set -o /DataMover/HardwareAcceleratedMove -i 1
            esxcli system settings advanced set -o /DataMover/HardwareAcceleratedInit -i 1
            """,
            """
            # Install additional VIBs
            esxcli software vib install -v /tmp/custom-vib.vib
            """,
            """
            # Configure firewall rules
            esxcli network firewall ruleset set --ruleset-id sshClient --enabled true
            esxcli network firewall ruleset set --ruleset-id ntpClient --enabled true
            """
        ]
    
    def _generate_kickstart(self, config: Dict[str, Any]) -> str:
        """Generate ESXi kickstart file"""
        return f"""
# ESXi Kickstart Configuration
# Generated: {datetime.now().isoformat()}

# Accept EULA
vmaccepteula

# Set root password
rootpw --iscrypted $6$encrypted_password_here

# Install on first disk
install --firstdisk --overwritevmfs

# Network configuration
network --bootproto=static --device=vmnic0 \
    --ip={config['network_config']['management']['subnet'].split('/')[0]} \
    --netmask=255.255.255.0 \
    --gateway=10.0.10.1 \
    --nameserver=8.8.8.8,8.8.4.4 \
    --hostname=esxi-{config['target_hardware'].lower().replace(' ', '-')}

# Reboot after installation
reboot

# Post-installation script
%post --interpreter=busybox

# Set hostname
esxcli system hostname set --fqdn=esxi-{config['target_hardware'].lower().replace(' ', '-')}.example.com

# Configure NTP
cat > /etc/ntp.conf << EOF
server ntp1.example.com
server ntp2.example.com
EOF

/etc/init.d/ntpd restart

# Configure syslog
esxcli system syslog config set --loghost='tcp://syslog.example.com:514'
esxcli system syslog reload

# Configure SSH
vim-cmd hostsvc/enable_ssh
vim-cmd hostsvc/start_ssh

# Configure advanced settings
{chr(10).join(config['post_install_scripts'])}

%post
"""
    
    def _estimate_deployment_time(self, image: ESXiImage) -> int:
        """Estimate deployment time in minutes"""
        base_time = 15  # Base installation time
        
        # Add time based on image size
        size_gb = image.file_size / (1024 ** 3)
        size_time = int(size_gb * 2)  # ~2 minutes per GB
        
        # Add time for customizations
        custom_time = 5 if image.image_type == ImageType.CUSTOM else 0
        
        return base_time + size_time + custom_time


async def main():
    """Main execution function"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Enterprise ESXi Image Manager')
    parser.add_argument('--config', default='/etc/esxi-manager/config.yaml',
                       help='Configuration file path')
    parser.add_argument('--action', required=True,
                       choices=['discover', 'download', 'sync', 'create-custom', 'deploy-package'],
                       help='Action to perform')
    parser.add_argument('--vendor', type=str, help='Vendor name')
    parser.add_argument('--version', type=str, help='ESXi version')
    parser.add_argument('--image-id', type=str, help='Image ID')
    parser.add_argument('--destination', type=str, help='Download destination')
    parser.add_argument('--vibs', nargs='+', help='VIBs to add to custom image')
    parser.add_argument('--hardware', type=str, help='Target hardware model')
    
    args = parser.parse_args()
    
    # Initialize manager
    manager = EnterpriseESXiImageManager(args.config)
    
    try:
        if args.action == 'discover':
            if args.vendor:
                vendor = VendorType(args.vendor.lower())
                images = await manager.discover_vendor_images(vendor)
            else:
                images = await manager.discover_broadcom_images()
            
            for image in images:
                print(f"{image.vendor.value}: {image.name} ({image.version})")
        
        elif args.action == 'sync':
            images = await manager.sync_all_sources()
            print(f"Synced {len(images)} images")
        
        elif args.action == 'download':
            if not args.image_id or not args.destination:
                parser.error('Image ID and destination required for download')
            
            # Get image from database
            session = manager.db_session()
            image_db = session.query(ESXiImageDB).filter_by(
                image_id=args.image_id
            ).first()
            session.close()
            
            if not image_db:
                print(f"Image not found: {args.image_id}")
                return
            
            image = manager._db_to_image(image_db)
            success = await manager.download_image(image, Path(args.destination))
            
            if success:
                print(f"Successfully downloaded: {image.name}")
            else:
                print("Download failed")
        
        elif args.action == 'create-custom':
            if not args.image_id or not args.vibs:
                parser.error('Image ID and VIBs required for custom image')
            
            # Get base image
            session = manager.db_session()
            image_db = session.query(ESXiImageDB).filter_by(
                image_id=args.image_id
            ).first()
            session.close()
            
            if not image_db:
                print(f"Base image not found: {args.image_id}")
                return
            
            base_image = manager._db_to_image(image_db)
            custom_image = await manager.create_custom_image(base_image, args.vibs)
            
            print(f"Created custom image: {custom_image.image_id}")
        
        elif args.action == 'deploy-package':
            if not args.hardware or not args.version:
                parser.error('Hardware and version required for deployment package')
            
            automation = ESXiDeploymentAutomation(manager)
            package = await automation.create_deployment_package(
                args.hardware,
                args.version,
                args.vibs
            )
            
            print(f"Created deployment package: {package['package_id']}")
            print(f"Estimated deployment time: {package['estimated_deployment_time']} minutes")
    
    finally:
        await manager.session.close()


if __name__ == "__main__":
    asyncio.run(main())
```

# [Enterprise ESXi Image Deployment](#enterprise-esxi-image-deployment)

## Production Deployment Pipeline

### Automated ESXi Deployment Script

```bash
#!/bin/bash
# Enterprise ESXi Automated Deployment Pipeline

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${CONFIG_FILE:-/etc/esxi-deployer/config.yaml}"
LOG_DIR="/var/log/esxi-deployer"
CACHE_DIR="/var/cache/esxi-images"
TFTP_ROOT="/var/lib/tftpboot"

# Create directories
mkdir -p "$LOG_DIR" "$CACHE_DIR" "$TFTP_ROOT/esxi"

# Logging
LOG_FILE="$LOG_DIR/deployment-$(date +%Y%m%d-%H%M%S).log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
    exit 1
}

# Parse configuration
parse_config() {
    if [[ ! -f "$CONFIG_FILE" ]]; then
        error "Configuration file not found: $CONFIG_FILE"
    fi
    
    # Extract values using yq or python
    if command -v yq &> /dev/null; then
        BROADCOM_URL=$(yq eval '.broadcom.portal_url' "$CONFIG_FILE")
        IMAGE_REPO=$(yq eval '.repository.path' "$CONFIG_FILE")
        DEPLOY_NETWORK=$(yq eval '.deployment.network' "$CONFIG_FILE")
    else
        # Fallback to python
        BROADCOM_URL=$(python3 -c "import yaml; print(yaml.safe_load(open('$CONFIG_FILE'))['broadcom']['portal_url'])")
        IMAGE_REPO=$(python3 -c "import yaml; print(yaml.safe_load(open('$CONFIG_FILE'))['repository']['path'])")
        DEPLOY_NETWORK=$(python3 -c "import yaml; print(yaml.safe_load(open('$CONFIG_FILE'))['deployment']['network'])")
    fi
}

# Setup PXE boot environment
setup_pxe_environment() {
    local esxi_version="$1"
    local image_path="$2"
    
    log "Setting up PXE environment for ESXi $esxi_version"
    
    # Create version-specific directory
    local pxe_dir="$TFTP_ROOT/esxi/$esxi_version"
    mkdir -p "$pxe_dir"
    
    # Extract ESXi image
    log "Extracting ESXi image to PXE directory"
    if [[ "$image_path" =~ \.iso$ ]]; then
        # Mount ISO and copy files
        local mount_point="/mnt/esxi-iso-$$"
        mkdir -p "$mount_point"
        mount -o loop,ro "$image_path" "$mount_point"
        
        cp -r "$mount_point"/* "$pxe_dir/"
        
        umount "$mount_point"
        rmdir "$mount_point"
    elif [[ "$image_path" =~ \.zip$ ]]; then
        # Extract offline bundle
        unzip -q "$image_path" -d "$pxe_dir/"
    fi
    
    # Create boot.cfg for PXE
    create_pxe_boot_cfg "$pxe_dir" "$esxi_version"
    
    # Setup DHCP configuration
    setup_dhcp_config "$esxi_version"
    
    log "PXE environment ready for ESXi $esxi_version"
}

# Create PXE boot configuration
create_pxe_boot_cfg() {
    local pxe_dir="$1"
    local version="$2"
    
    log "Creating PXE boot configuration"
    
    # Modify boot.cfg for network boot
    if [[ -f "$pxe_dir/boot.cfg" ]]; then
        # Backup original
        cp "$pxe_dir/boot.cfg" "$pxe_dir/boot.cfg.orig"
        
        # Update paths for network boot
        sed -i "s|/||g" "$pxe_dir/boot.cfg"
        sed -i "s|^kernel=|kernel=esxi/$version/|" "$pxe_dir/boot.cfg"
        sed -i "s|^modules=|modules=esxi/$version/|" "$pxe_dir/boot.cfg"
        
        # Add network boot parameters
        echo "kernelopt=ks=http://$DEPLOY_NETWORK/ks/esxi-$version.cfg" >> "$pxe_dir/boot.cfg"
    fi
    
    # Create iPXE configuration
    cat > "$TFTP_ROOT/esxi-$version.ipxe" <<EOF
#!ipxe
# ESXi $version iPXE boot configuration

echo Booting ESXi $version installer...
kernel tftp://\${next-server}/esxi/$version/mboot.c32 -c tftp://\${next-server}/esxi/$version/boot.cfg
boot
EOF
}

# Setup DHCP for PXE boot
setup_dhcp_config() {
    local version="$1"
    
    log "Configuring DHCP for PXE boot"
    
    # Create DHCP configuration snippet
    cat > "/etc/dhcp/dhcpd.conf.d/esxi-$version.conf" <<EOF
# ESXi $version PXE boot configuration

class "esxi-installers" {
    match if substring(option vendor-class-identifier, 0, 9) = "PXEClient";
}

subnet $DEPLOY_NETWORK netmask 255.255.255.0 {
    option routers ${DEPLOY_NETWORK%.*}.1;
    option domain-name-servers 8.8.8.8, 8.8.4.4;
    
    pool {
        allow members of "esxi-installers";
        range ${DEPLOY_NETWORK%.*}.100 ${DEPLOY_NETWORK%.*}.200;
        
        # PXE boot options
        next-server ${DEPLOY_NETWORK%.*}.10;  # TFTP server
        
        if exists user-class and option user-class = "iPXE" {
            filename "esxi-$version.ipxe";
        } else {
            filename "undionly.kpxe";
        }
    }
}
EOF
    
    # Restart DHCP service
    systemctl restart isc-dhcp-server || systemctl restart dhcpd
}

# Generate kickstart file
generate_kickstart() {
    local hostname="$1"
    local ip_address="$2"
    local root_password="$3"
    local version="$4"
    
    log "Generating kickstart file for $hostname"
    
    local ks_file="/var/www/html/ks/esxi-$hostname.cfg"
    mkdir -p "$(dirname "$ks_file")"
    
    cat > "$ks_file" <<EOF
# ESXi Kickstart Configuration
# Host: $hostname
# Generated: $(date)

# Accept EULA
vmaccepteula

# Set root password
rootpw --iscrypted $(python3 -c "import crypt; print(crypt.crypt('$root_password', crypt.mksalt(crypt.METHOD_SHA512)))")

# Install on first disk, overwrite VMFS
install --firstdisk=local --overwritevmfs

# Network configuration
network --bootproto=static --device=vmnic0 --ip=$ip_address --netmask=255.255.255.0 --gateway=${ip_address%.*}.1 --nameserver=8.8.8.8,8.8.4.4 --hostname=$hostname

# Keyboard
keyboard 'US Default'

# Reboot after installation
reboot

# Post-installation script
%firstboot --interpreter=busybox

# Wait for network
sleep 30

# Set hostname
esxcli system hostname set --host=$hostname --domain=example.com

# Configure NTP
cat > /etc/ntp.conf << 'NTPEOF'
server 0.pool.ntp.org
server 1.pool.ntp.org
driftfile /etc/ntp.drift
NTPEOF

/sbin/chkconfig ntpd on
/etc/init.d/ntpd start

# Configure syslog
esxcli system syslog config set --loghost='tcp://syslog.example.com:514'
esxcli system syslog reload

# Enable SSH
vim-cmd hostsvc/enable_ssh
vim-cmd hostsvc/start_ssh

# Configure firewall
esxcli network firewall ruleset set --ruleset-id sshClient --enabled true
esxcli network firewall ruleset set --ruleset-id ntpClient --enabled true
esxcli network firewall ruleset set --ruleset-id httpClient --enabled true

# Set advanced configuration options
esxcli system settings advanced set -o /UserVars/SuppressShellWarning -i 1
esxcli system settings advanced set -o /Net/TcpipHeapSize -i 32
esxcli system settings advanced set -o /Net/TcpipHeapMax -i 1536

# Configure scratch location
DATASTORE=\$(esxcli storage filesystem list | grep VMFS | head -1 | awk '{print \$1}')
mkdir -p \${DATASTORE}/.scratch
esxcli system settings advanced set -o /ScratchConfig/ConfiguredScratchLocation -s \${DATASTORE}/.scratch

# Report installation complete
wget -O - "http://$DEPLOY_NETWORK/api/v1/installation/complete?host=$hostname&status=success" || true

%post
EOF
    
    log "Kickstart file created: $ks_file"
}

# Deploy ESXi to hardware
deploy_esxi() {
    local hardware_model="$1"
    local esxi_version="$2"
    local hostname="$3"
    local ip_address="$4"
    
    log "Deploying ESXi $esxi_version to $hardware_model ($hostname)"
    
    # Get appropriate image
    local image_path=$(find_esxi_image "$hardware_model" "$esxi_version")
    
    if [[ -z "$image_path" ]]; then
        error "No suitable ESXi image found for $hardware_model $esxi_version"
    fi
    
    # Setup PXE if needed
    setup_pxe_environment "$esxi_version" "$image_path"
    
    # Generate kickstart
    generate_kickstart "$hostname" "$ip_address" "TempP@ssw0rd!" "$esxi_version"
    
    # Trigger hardware boot (vendor-specific)
    case "$hardware_model" in
        *"PowerEdge"*)
            deploy_dell_server "$hostname" "$ip_address"
            ;;
        *"ProLiant"*)
            deploy_hpe_server "$hostname" "$ip_address"
            ;;
        *"ThinkSystem"*)
            deploy_lenovo_server "$hostname" "$ip_address"
            ;;
        *)
            log "Generic deployment for $hardware_model"
            ;;
    esac
    
    # Monitor installation
    monitor_installation "$hostname" "$ip_address"
}

# Find ESXi image for hardware
find_esxi_image() {
    local hardware="$1"
    local version="$2"
    
    # Query image database
    local image_path=$(/usr/local/bin/esxi-image-manager \
        --action find \
        --hardware "$hardware" \
        --version "$version" \
        --format path)
    
    if [[ -n "$image_path" ]] && [[ -f "$image_path" ]]; then
        echo "$image_path"
    else
        # Try to download if not cached
        log "Image not found locally, attempting download"
        /usr/local/bin/esxi-image-manager \
            --action download \
            --hardware "$hardware" \
            --version "$version" \
            --destination "$CACHE_DIR"
        
        # Retry finding
        find_esxi_image "$hardware" "$version"
    fi
}

# Deploy Dell server via iDRAC
deploy_dell_server() {
    local hostname="$1"
    local ip_address="$2"
    
    log "Deploying Dell server via iDRAC"
    
    # Get iDRAC IP from inventory
    local idrac_ip=$(get_idrac_ip "$hostname")
    
    # Configure one-time boot to PXE
    racadm -r "$idrac_ip" -u root -p calvin \
        set iDRAC.ServerBoot.FirstBootDevice PXE
    
    # Reboot server
    racadm -r "$idrac_ip" -u root -p calvin serveraction powercycle
    
    log "Dell server PXE boot initiated"
}

# Deploy HPE server via iLO
deploy_hpe_server() {
    local hostname="$1"
    local ip_address="$2"
    
    log "Deploying HPE server via iLO"
    
    # Get iLO IP from inventory
    local ilo_ip=$(get_ilo_ip "$hostname")
    
    # Set one-time boot to PXE
    curl -k -u "admin:password" \
        -H "Content-Type: application/json" \
        -X PATCH \
        "https://$ilo_ip/redfish/v1/Systems/1" \
        -d '{"Boot": {"BootSourceOverrideTarget": "Pxe", "BootSourceOverrideEnabled": "Once"}}'
    
    # Reboot server
    curl -k -u "admin:password" \
        -H "Content-Type: application/json" \
        -X POST \
        "https://$ilo_ip/redfish/v1/Systems/1/Actions/ComputerSystem.Reset" \
        -d '{"ResetType": "ForceRestart"}'
    
    log "HPE server PXE boot initiated"
}

# Monitor installation progress
monitor_installation() {
    local hostname="$1"
    local ip_address="$2"
    local timeout=3600  # 1 hour timeout
    local start_time=$(date +%s)
    
    log "Monitoring installation of $hostname"
    
    while true; do
        # Check if host is reachable
        if ping -c 1 -W 5 "$ip_address" &> /dev/null; then
            # Try SSH connection
            if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
                root@"$ip_address" "esxcli system version get" &> /dev/null; then
                log "Installation completed successfully for $hostname"
                
                # Run post-installation tasks
                run_post_install "$hostname" "$ip_address"
                
                return 0
            fi
        fi
        
        # Check timeout
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))
        
        if [[ $elapsed -gt $timeout ]]; then
            error "Installation timeout for $hostname"
        fi
        
        # Progress indicator
        echo -n "."
        sleep 30
    done
}

# Run post-installation tasks
run_post_install() {
    local hostname="$1"
    local ip_address="$2"
    
    log "Running post-installation tasks for $hostname"
    
    # Wait for services to stabilize
    sleep 60
    
    # Configure license
    ssh root@"$ip_address" "vim-cmd vimsvc/license --set XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
    
    # Join vCenter if configured
    if [[ -n "${VCENTER_SERVER:-}" ]]; then
        log "Adding host to vCenter"
        # This would typically use PowerCLI or vCenter API
    fi
    
    # Apply host profile
    apply_host_profile "$hostname" "$ip_address"
    
    # Configure distributed switch
    configure_distributed_switch "$hostname" "$ip_address"
    
    log "Post-installation tasks completed for $hostname"
}

# Main deployment function
main() {
    local action="${1:-help}"
    
    case "$action" in
        deploy)
            shift
            deploy_esxi "$@"
            ;;
        setup-pxe)
            shift
            setup_pxe_environment "$@"
            ;;
        generate-ks)
            shift
            generate_kickstart "$@"
            ;;
        monitor)
            shift
            monitor_installation "$@"
            ;;
        help|*)
            cat <<EOF
Usage: $0 <action> [arguments]

Actions:
    deploy <hardware> <version> <hostname> <ip>  - Deploy ESXi to hardware
    setup-pxe <version> <image-path>            - Setup PXE environment
    generate-ks <hostname> <ip> <password>      - Generate kickstart file
    monitor <hostname> <ip>                     - Monitor installation
    help                                        - Show this help

Examples:
    $0 deploy "PowerEdge R640" "7.0U3" "esxi-01" "192.168.1.100"
    $0 setup-pxe "7.0U3" "/cache/VMware-ESXi-7.0U3-dell.iso"
EOF
            ;;
    esac
}

# Parse configuration
parse_config

# Execute main function
main "$@"
```

## Enterprise Image Repository Management

### Automated Image Sync Service

```python
#!/usr/bin/env python3
"""
Enterprise ESXi Image Repository Sync Service
"""

import asyncio
import schedule
import time
from systemd import daemon
import logging
from typing import List, Dict, Any

class ESXiImageSyncService:
    """Background service for ESXi image synchronization"""
    
    def __init__(self, config_path: str):
        self.config_path = config_path
        self.manager = None
        self.logger = logging.getLogger(__name__)
        self.running = True
    
    async def start(self):
        """Start the sync service"""
        self.logger.info("Starting ESXi Image Sync Service")
        
        # Initialize manager
        from esxi_image_manager import EnterpriseESXiImageManager
        self.manager = EnterpriseESXiImageManager(self.config_path)
        
        # Schedule tasks
        schedule.every(6).hours.do(lambda: asyncio.create_task(self.sync_images()))
        schedule.every(24).hours.do(lambda: asyncio.create_task(self.cleanup_old_images()))
        schedule.every(1).hours.do(lambda: asyncio.create_task(self.check_new_releases()))
        
        # Notify systemd
        daemon.notify('READY=1')
        
        # Initial sync
        await self.sync_images()
        
        # Run scheduler
        while self.running:
            schedule.run_pending()
            await asyncio.sleep(60)
    
    async def sync_images(self):
        """Sync all image sources"""
        try:
            self.logger.info("Starting image synchronization")
            images = await self.manager.sync_all_sources()
            
            # Download critical images
            await self.download_critical_images(images)
            
            # Update metrics
            daemon.notify(f'STATUS=Synced {len(images)} images')
            
        except Exception as e:
            self.logger.error(f"Sync error: {e}")
    
    async def download_critical_images(self, images: List[Any]):
        """Download images marked as critical"""
        critical_versions = ['7.0U3', '8.0U2']  # Configure as needed
        
        for image in images:
            if any(v in image.version for v in critical_versions):
                if not image.downloaded:
                    self.logger.info(f"Downloading critical image: {image.name}")
                    await self.manager.download_image(
                        image,
                        Path(f"/var/cache/esxi-images/{image.vendor.value}/{image.name}")
                    )
    
    async def cleanup_old_images(self):
        """Clean up old image versions"""
        retention_days = 90
        
        self.logger.info("Cleaning up old images")
        
        # Implementation would check image age and remove old versions
        # while keeping latest stable version for each major release
    
    async def check_new_releases(self):
        """Check for new ESXi releases and send notifications"""
        # Implementation would check for new releases and send
        # notifications via email/Slack/webhooks
        pass
    
    def stop(self):
        """Stop the service"""
        self.running = False
        daemon.notify('STOPPING=1')

if __name__ == "__main__":
    import signal
    
    service = ESXiImageSyncService('/etc/esxi-manager/config.yaml')
    
    # Handle signals
    def signal_handler(signum, frame):
        service.stop()
    
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    
    # Run service
    asyncio.run(service.start())
```

# [Best Practices and Troubleshooting](#best-practices-and-troubleshooting)

## Image Management Best Practices

### 1. Version Control
- Maintain a clear versioning strategy for custom images
- Tag images with build date and included driver versions
- Document all customizations and their purposes
- Use git for kickstart and configuration management

### 2. Security Considerations
- Verify all image checksums before deployment
- Use secure storage for image repositories
- Implement access controls for image modification
- Regular security scanning of custom images
- Rotate credentials for portal access

### 3. Testing Strategy
- Maintain a test environment for new images
- Automated testing of driver compatibility
- Performance benchmarking of new versions
- Rollback procedures for failed deployments

### 4. Documentation Requirements
- Hardware compatibility matrices
- Driver version tracking
- Known issues and workarounds
- Deployment runbooks

## Common Troubleshooting Scenarios

### Portal Access Issues

```bash
# Test Broadcom portal connectivity
curl -I https://support.broadcom.com

# Verify credentials
python3 -c "
from selenium import webdriver
driver = webdriver.Chrome()
driver.get('https://support.broadcom.com')
# Check page elements
"

# Debug portal navigation
export SELENIUM_DEBUG=1
esxi-image-manager --action discover --debug
```

### Image Download Problems

```bash
# Check available space
df -h /var/cache/esxi-images

# Test download with wget
wget --spider <image-url>

# Resume interrupted download
wget -c <image-url> -O <destination>

# Verify partial downloads
ls -la /var/cache/esxi-images/partial/
```

### PXE Boot Failures

```bash
# Check TFTP service
systemctl status tftpd-hpa
netstat -ulnp | grep :69

# Verify DHCP configuration
dhcpd -t -cf /etc/dhcp/dhcpd.conf

# Test PXE file accessibility
tftp localhost -c get esxi/boot.cfg

# Monitor PXE requests
tcpdump -i any -n port 67 or port 68 or port 69
```

### Deployment Failures

```bash
# Check kickstart file syntax
ksvalidator /var/www/html/ks/esxi.cfg

# Monitor HTTP access for kickstart
tail -f /var/log/apache2/access.log | grep ks

# Verify network connectivity during install
ping -c 4 <esxi-installer-ip>

# Check installation logs (if accessible)
ssh root@<esxi-ip> "cat /var/log/esxi_install.log"
```

## Conclusion

Enterprise ESXi OEM image management requires comprehensive automation frameworks that handle the entire lifecycle from discovery through deployment. By implementing these advanced systems, organizations can maintain consistent, secure, and efficient virtualization infrastructure deployments across diverse hardware platforms at scale.

The combination of automated discovery, intelligent caching, custom image creation, and zero-touch deployment provides the foundation for modern software-defined data centers. These implementations ensure that ESXi deployments remain standardized, compliant, and optimized for each specific hardware platform while minimizing manual intervention and potential for human error.