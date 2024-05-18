#!/bin/bash

echo "Checking for draft content"
cd blog/content/post
if [[ -z $(grep -R 'draft: true' . | grep -v '_template.md') ]]
then
  echo "No draft content found"
else
  echo "Draft content found"
  #exit 1
fi
