import { strToU8, zipSync } from "fflate";

/** 构造最小但结构合法的 EPUB3 字节流，供解析/内容测试与消费方复用。 */
export function makeFixtureEpub(opts?: {
  identifier?: string | null;
  coverViaMeta?: boolean;
  /** 覆盖 <dc:title>；变更标题即改变字节流，用于构造「同 identifier、不同内容」的夹具。 */
  title?: string;
}): Uint8Array {
  const identifier = opts?.identifier === undefined ? "urn:uuid:fixture-001" : opts.identifier;
  const coverViaMeta = opts?.coverViaMeta ?? false;
  const title = opts?.title ?? "Fixture Book";

  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const identifierEl =
    identifier !== null ? `\n    <dc:identifier id="bookid">${identifier}</dc:identifier>` : "";
  const uniqueIdentifierAttr = identifier !== null ? ` unique-identifier="bookid"` : "";

  const coverManifestItem = coverViaMeta
    ? `<item id="cover-img" href="cover.png" media-type="image/png"/>`
    : `<item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>`;
  const coverMetaEl = coverViaMeta ? `\n    <meta name="cover" content="cover-img"/>` : "";

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"${uniqueIdentifierAttr}>
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${identifierEl}
    <dc:title>${title}</dc:title>
    <dc:creator>Test Author</dc:creator>${coverMetaEl}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${coverManifestItem}
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body><nav epub:type="toc"><ol>
    <li><a href="ch1.xhtml">Chapter One</a></li>
    <li><a href="ch2.xhtml">Chapter Two</a></li>
  </ol></nav></body>
</html>`;
  const ch1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1><p>Hello world.</p><p>Second paragraph.</p></body></html>`;
  const ch2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter Two</h1><p>The end.</p></body></html>`;
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/nav.xhtml": strToU8(nav),
    "OEBPS/ch1.xhtml": strToU8(ch1),
    "OEBPS/ch2.xhtml": strToU8(ch2),
    "OEBPS/cover.png": png,
  });
}
