import shutil
import os

source = r"D:\claud QIJI\index.html"
destination = r"D:\claud QIJI\index_backup_20260418_mobile_anim.html"

try:
    shutil.copy2(source, destination)
    print(f"File copied successfully!")
    print(f"Source: {source}")
    print(f"Destination: {destination}")
    print(f"Destination file size: {os.path.getsize(destination)} bytes")
except Exception as e:
    print(f"Error: {e}")
