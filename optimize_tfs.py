import re
import os

path = 'backend/tfs_tool.py'
if not os.path.exists(path):
    print(f"File {path} not found")
    exit(1)

content = open(path, encoding='utf-8').read()

# 1. Replace requests.get(url, ... with _tfs_request('GET', url, ...
content = re.sub(r'requests\.get\(([^,)]+)', r"_tfs_request('GET', \1", content)
# 2. Replace requests.post(url, ... with _tfs_request('POST', url, ...
content = re.sub(r'requests\.post\(([^,)]+)', r"_tfs_request('POST', \1", content)
# 3. Replace requests.patch(url, ... with _tfs_request('PATCH', url, ...
content = re.sub(r'requests\.patch\(([^,)]+)', r"_tfs_request('PATCH', \1", content)

# 4. Handle the auth/headers to pass credentials directly to our pool
# Find calls that use auth=auth, headers=headers and convert them
content = content.replace('auth=auth, headers=headers', 'username=username, password=password, pat=pat')
content = content.replace('auth=auth_obj, headers=headers', 'username=username, password=password, pat=pat')
content = content.replace('auth=auth, headers=headers.copy()', 'username=username, password=password, pat=pat')
content = content.replace('auth=auth_obj, headers=headers.copy()', 'username=username, password=password, pat=pat')

# 5. Fix any double username/password if regex caught them twice
# (Wait, our _tfs_request takes username=None, password=None, pat=None)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print('✅ tfs_tool.py successfully patched for performance')
