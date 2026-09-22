"""Regression tests for the PPTX media handling (stdlib unittest).

Run:  python3 -m unittest tests.test_ppt_parser_media -v
"""
import base64
import json
import os
import sqlite3
import struct
import sys
import unittest
import zipfile
import io

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ppt_parser


def _stretchdibits_emf(width, height, pixel):
    """A minimal EMF whose only content is one EMR_STRETCHDIBITS record."""
    stride = ((width * 3) + 3) // 4 * 4
    bits = bytearray()
    for _ in range(height):
        row = bytearray()
        for _x in range(width):
            row += bytes((pixel[0], pixel[1], pixel[2]))
        row += b"\x00" * (stride - len(row))
        bits += row
    bih = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(bits), 0, 0, 0, 0)
    body = bih + bytes(bits)
    hdr_size = 8 + 16 + 16 + 8 + 20 + 8
    rec = struct.pack("<II", 81, hdr_size + len(body))
    rec += b"\x00" * 16 + b"\x00" * 16 + b"\x00" * 8 + b"\x00" * 20 + b"\x00" * 8
    rec = struct.pack("<II", 81, hdr_size + len(body)) + rec[8:] + body
    emf = struct.pack("<II", 1, 88) + b"\x00" * 80
    emf += rec
    emf += struct.pack("<II", 14, 20) + b"\x00" * 12
    return emf


def _pptx_with(media_name, media_bytes):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("ppt/presentation.xml",
                   '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                   'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                   '<p:sldSz cx="9144000" cy="6858000"/></p:presentation>')
        z.writestr("ppt/slides/slide1.xml",
                   '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                   'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                   '<p:cSld><p:spTree><p:pic><p:blipFill>'
                   '<a:blip r:embed="rId2"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>')
        z.writestr("ppt/slides/_rels/slide1.xml.rels",
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                   'relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
                   '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                   'relationships/image" Target="../media/%s"/></Relationships>' % media_name)
        z.writestr("ppt/media/" + media_name, media_bytes)
    return buf.getvalue()


class MediaHandlingTest(unittest.TestCase):
    def test_emf_is_converted_to_a_displayable_png(self):
        emf = _stretchdibits_emf(64, 48, (200, 30, 30))
        out = ppt_parser.parse_pptx(_pptx_with("image1.emf", emf))
        imgs = out["slides"][0]["images"]
        self.assertEqual(len(imgs), 1)
        self.assertEqual(imgs[0]["mime"], "image/png")
        self.assertTrue(imgs[0]["dataUrl"].startswith("data:image/png;base64,"))
        self.assertTrue(imgs[0]["name"].endswith(".png"))
        self.assertEqual(out["skippedImages"], [])

    def test_recovered_png_really_holds_the_picture(self):
        emf = _stretchdibits_emf(40, 30, (10, 220, 40))
        png = ppt_parser.emf_to_png(emf)
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
        w, h = struct.unpack(">II", png[16:24])
        self.assertEqual((w, h), (40, 30))

    def test_mislabelled_extension_follows_the_bytes(self):
        png = ppt_parser._write_png(4, 4, [b"\xff\x00\x00" * 4] * 4)
        out = ppt_parser.parse_pptx(_pptx_with("image2.emf", png))
        imgs = out["slides"][0]["images"]
        self.assertEqual(len(imgs), 1, "bytes say PNG, so it must be kept")
        self.assertEqual(imgs[0]["mime"], "image/png")

    def test_undisplayable_media_is_skipped_and_reported(self):
        tiff = b"II*\x00" + b"\x00" * 200
        out = ppt_parser.parse_pptx(_pptx_with("image3.tiff", tiff))
        self.assertEqual(out["slides"][0]["images"], [])
        self.assertEqual(out["skippedImages"], ["image3.tiff"])

    def test_layout_relationship_is_not_treated_as_an_image(self):
        out = ppt_parser.parse_pptx(_pptx_with("image4.png",
                                              ppt_parser._write_png(2, 2, [b"\x00\x00\x00" * 2] * 2)))
        names = [i["name"] for i in out["slides"][0]["images"]]
        self.assertEqual(names, ["image4.png"])


if __name__ == "__main__":
    unittest.main()
