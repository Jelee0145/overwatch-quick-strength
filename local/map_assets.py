"""Fetch only known public map images; embed cached bytes for safe PNG export."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request

ROOT=Path(__file__).resolve().parent
MAPS={str(m['guid']):m for m in json.loads((ROOT/'data/maps.json').read_text(encoding='utf-8-sig'))}
CACHE=ROOT/'assets/maps'
ALLOWED={'img.166.net','d15f34w2p8l1cc.cloudfront.net'}

def image_mime(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):return 'image/png'
    if data.startswith(b'\xff\xd8\xff'):return 'image/jpeg'
    if data[:4]==b'RIFF' and data[8:12]==b'WEBP':return 'image/webp'
    raise ValueError('地图素材返回的不是图片')

def map_image(guid):
    item=MAPS.get(str(guid))
    if not item:raise ValueError('没有该地图的官方素材配置')
    url=item['icon'];parts=urllib.parse.urlsplit(url)
    if parts.scheme!='https' or parts.hostname not in ALLOWED:raise ValueError('地图素材来源不在配置白名单中')
    target=CACHE/(hashlib.sha256(url.encode()).hexdigest()+'.img')
    if target.exists():data=target.read_bytes()
    else:
        for attempt in range(2):
            try:
                with urllib.request.urlopen(url,timeout=12) as response:
                    if urllib.parse.urlsplit(response.url).hostname not in ALLOWED:raise ValueError('地图图片跳转到了未知来源')
                    data=response.read(8*1024*1024+1)
                if len(data)>8*1024*1024:raise ValueError('地图图片过大')
                image_mime(data)
                CACHE.mkdir(parents=True,exist_ok=True)
                # Concurrent writes are identical; separate temporary files avoid races.
                import tempfile,os
                fd,temp=tempfile.mkstemp(dir=CACHE,suffix='.tmp')
                with os.fdopen(fd,'wb') as f:f.write(data)
                Path(temp).replace(target)
                break
            except (OSError,ValueError):
                if attempt:raise
    return 'data:'+image_mime(data)+';base64,'+base64.b64encode(data).decode()

def fetch_maps(guids):
    if not isinstance(guids,list) or len(guids)>50 or any(not isinstance(g,str) for g in guids):raise ValueError('地图列表格式错误')
    images,errors={},{}
    def one(guid):
        try:return guid,map_image(guid),None
        except Exception:return guid,None,'地图图片获取失败，稍后可重新生成重试'
    with ThreadPoolExecutor(max_workers=4) as pool:
        for guid,value,error in pool.map(one,dict.fromkeys(guids)):
            if error:errors[guid]=error
            else:images[guid]=value
    return {'images':images,'errors':errors}
