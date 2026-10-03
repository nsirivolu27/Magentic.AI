"""Package the built extension using only Python's standard library."""
from pathlib import Path
import json
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED

repo = Path(__file__).resolve().parents[2]
source = repo / 'dist' / 'vscode' / 'extension'
manifest = json.loads((source / 'package.json').read_text(encoding='utf-8'))
target = source.parent / f"{manifest['name']}-{manifest['version']}.vsix"
metadata = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="{escape(manifest['name'])}" Version="{escape(manifest['version'])}" Publisher="{escape(manifest['publisher'])}"/><DisplayName>{escape(manifest['displayName'])}</DisplayName><Description xml:space="preserve">{escape(manifest['description'])}</Description><Tags>AI,workspace</Tags><Categories>Other</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(manifest['engines']['vscode'])}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/></Properties><License>extension/LICENSE</License></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/></Assets>
</PackageManifest>'''
content_types = '''<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="html" ContentType="text/html"/><Default Extension="css" ContentType="text/css"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="txt" ContentType="text/plain"/></Types>'''
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', metadata)
    archive.writestr('[Content_Types].xml', content_types)
    for path in sorted(source.rglob('*')):
        if path.is_file():
            archive.write(path, 'extension/' + path.relative_to(source).as_posix())
with ZipFile(target) as archive:
    assert archive.testzip() is None
    assert 'extension/dist/extension.cjs' in archive.namelist()
print(target)
