#!/bin/bash -x
if [ $1 == "amd64" ]
then
  echo "amd64"
  wget --no-check-certificate https://github.com/gohugoio/hugo/releases/download/v0.88.1/hugo_0.88.1_Linux-64bit.tar.gz;
fi
if [ $1 == "arm64" ]
then
  echo "arm64"
  wget --no-check-certificate https://github.com/gohugoio/hugo/releases/download/v0.88.1/hugo_0.88.1_Linux-ARM64.tar.gz;
fi
tar xvzf hugo_*.tar.gz
cp hugo /usr/bin/hugo
chmod +x /usr/bin/hugo
rm -rf hugo_*.tar.gz