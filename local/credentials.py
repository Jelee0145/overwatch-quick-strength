"""Windows-user-bound secret storage. Never expose stored secrets through HTTP."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import threading

class StoreError(Exception): pass
class Blob(ctypes.Structure):
    _fields_=[('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]

def crypt(data, decrypt=False):
    if os.name!='nt': raise StoreError('凭证加密保存需要 Windows；可使用本次临时凭据')
    buf=ctypes.create_string_buffer(data)
    source=Blob(len(data),ctypes.cast(buf,ctypes.POINTER(ctypes.c_ubyte)));out=Blob()
    dll=ctypes.WinDLL('crypt32',use_last_error=True)
    if decrypt:
        fn=dll.CryptUnprotectData
        fn.argtypes=[ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
    else:
        fn=dll.CryptProtectData
        fn.argtypes=[ctypes.POINTER(Blob),wintypes.LPCWSTR,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
    fn.restype=wintypes.BOOL
    if not fn(ctypes.byref(source),None,None,None,None,1,ctypes.byref(out)):
        raise StoreError('无法解密本机凭证，请在当前 Windows 账户重新保存' if decrypt else 'Windows 凭证加密失败')
    try:return ctypes.string_at(out.data,out.size)
    finally:
        free=ctypes.WinDLL('kernel32').LocalFree
        free.argtypes=[ctypes.c_void_p];free.restype=ctypes.c_void_p;free(out.data)

class CredentialStore:
    def __init__(self,root): self.path=Path(root)/'credentials.dpapi';self.lock=threading.RLock()
    def load(self):
        with self.lock:
            if not self.path.exists():return {}
            try:return json.loads(crypt(self.path.read_bytes(),True))
            except (OSError,ValueError) as exc:raise StoreError('凭证存储损坏，请重新保存') from None
    def save(self,config):
        safe={k:str(config.get(k,'')) for k in ('roleId','token','dts','server')}
        with self.lock:
            encoded=crypt(json.dumps(safe).encode())
            self.path.parent.mkdir(parents=True,exist_ok=True)
            temp=self.path.with_suffix('.tmp');temp.write_bytes(encoded);temp.replace(self.path)
    def clear(self):
        with self.lock:self.path.unlink(missing_ok=True)
    def status(self):
        config=self.load()
        return {'saved':bool(config),'roleId':config.get('roleId',''),'dts':config.get('dts','2026'),'server':config.get('server','1')}
