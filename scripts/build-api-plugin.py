"""Build a credential-free AstrBot website API plugin ZIP from an explicit allowlist."""
from pathlib import Path
import hashlib
import zipfile

root = Path(__file__).resolve().parent.parent
source = root / "plugins" / "astrbot_plugin_owqs_api"
files = ("main.py", "api_client.py", "renderer.py", "documents.py", "website.json", "requirements.txt", "metadata.yaml", "_conf_schema.json", "README.md")
output = root / "dist" / "astrbot_plugin_owqs_api-1.5.1.zip"
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for filename in files:
        candidate = (source / filename).resolve()
        if candidate.parent != source.resolve() or not candidate.is_file():
            raise RuntimeError("Unexpected plugin source path")
        archive.write(candidate, "astrbot_plugin_owqs_api/" + filename)
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix(".zip.sha256").write_text(checksum + "  " + output.name + "\n", encoding="utf-8")
print("API plugin package ready: " + str(output))
