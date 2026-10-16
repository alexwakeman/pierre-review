import { describe, expect, it } from 'vitest';
import { REFERENCE_DOC_MAX_BYTES } from '@pierre-review/shared';
import { splitMarkdown } from './split.js';
import { UNSUPPORTED_MESSAGE, convertToMarkdown, htmlToMarkdown, pdfPageCount, sniffFetched, sniffUpload } from './convert.js';

const b = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('sniffUpload — the kind comes from the bytes', () => {
  it('reads PDF, docx, markdown, html and text', () => {
    expect(sniffUpload(b('%PDF-1.7\n...'), 'x.bin')).toMatchObject({ ok: true, kind: 'pdf' });
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), b('....word/document.xml....')]);
    expect(sniffUpload(zip, 'spec.docx')).toMatchObject({ ok: true, kind: 'docx' });
    expect(sniffUpload(b('# Hi'), 'notes.md')).toMatchObject({ ok: true, kind: 'markdown' });
    expect(sniffUpload(b('<!doctype html><html><body>x</body></html>'), 'page.txt')).toMatchObject({ ok: true, kind: 'html' });
    expect(sniffUpload(b('plain words'), 'notes.txt')).toMatchObject({ ok: true, kind: 'text' });
    expect(sniffUpload(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]), 'u16.txt')).toMatchObject({ ok: true, kind: 'text' });
  });

  it('refuses what it cannot read, by the bytes, whatever the name says', () => {
    expect(sniffUpload(Buffer.alloc(0), 'a.txt')).toEqual({ ok: false, message: 'The file is empty.' });
    expect(sniffUpload(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), 'old.doc')).toMatchObject({ ok: false, message: expect.stringMatching(/\.doc files are not read/) });
    expect(sniffUpload(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), b('xl/workbook.xml')]), 'sheet.docx')).toMatchObject({ ok: false });
    expect(sniffUpload(b('{\\rtf1 hello}'), 'a.rtf')).toMatchObject({ ok: false });
    expect(sniffUpload(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), 'renamed.md')).toEqual({ ok: false, message: UNSUPPORTED_MESSAGE });
    expect(sniffUpload(Buffer.from([0xc3, 0x28, 0x41]), 'bad-utf8.txt')).toEqual({ ok: false, message: UNSUPPORTED_MESSAGE });
  });

  it('refuses a file over the cap', () => {
    const big = Buffer.alloc(REFERENCE_DOC_MAX_BYTES + 1, 0x61);
    expect(sniffUpload(big, 'big.txt')).toMatchObject({ ok: false, message: expect.stringMatching(/too large/) });
  });

  it('a fetched page is judged by its content type, then its bytes', () => {
    expect(sniffFetched(b('%PDF-1.4'), 'application/pdf', 'https://x.test/a')).toMatchObject({ ok: true, kind: 'pdf' });
    expect(sniffFetched(b('<p>x</p>'), 'text/html; charset=utf-8', 'https://x.test/a')).toMatchObject({ ok: true, kind: 'html' });
    expect(sniffFetched(b('# x'), 'text/plain', 'https://x.test/README.md')).toMatchObject({ ok: true, kind: 'markdown' });
    expect(sniffFetched(b('x'), 'image/png', 'https://x.test/a.png')).toMatchObject({ ok: false });
  });
});

describe('pdfPageCount', () => {
  it('counts page objects, or reads the page tree count', () => {
    expect(pdfPageCount(b('%PDF-1.4 1 0 obj << /Type /Page >> 2 0 obj << /Type /Page >> 3 0 obj << /Type /Pages /Count 2 >>'))).toBe(2);
    expect(pdfPageCount(b('%PDF-1.5 << /Count 37 /Kids [] /Type /Pages >>'))).toBe(37);
    expect(pdfPageCount(b('%PDF-1.5 compressed'))).toBeNull();
  });
});

describe('convertToMarkdown (the workspace has the converters installed)', () => {
  it('turns a web page into markdown: tables kept, scripts, nav and images dropped, unsafe links unlinked', async () => {
    const html = `<html><head><title>Rates &amp; fees</title></head><body><nav>menu</nav><main>
      <h1>Rates</h1><p>See <a href="https://example.com/a">this</a> and <a href="javascript:alert(1)">that</a>.</p>
      <img src="data:image/png;base64,AAAA" alt="A chart"><script>steal()</script>
      <table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Basic</td><td>$5</td></tr></tbody></table>
      </main></body></html>`;
    const out = await convertToMarkdown('html', b(html));
    expect(out.title).toBe('Rates & fees');
    expect(out.markdown).toContain('# Rates');
    expect(out.markdown).toContain('[this](https://example.com/a)');
    expect(out.markdown).not.toContain('javascript:');
    expect(out.markdown).toContain('that');
    expect(out.markdown).toContain('[Image: A chart]');
    expect(out.markdown).not.toContain('data:image');
    expect(out.markdown).not.toContain('steal');
    expect(out.markdown).not.toContain('menu');
    expect(out.markdown).toMatch(/\| Plan \| Price \|/);
  });

  it('passes markdown through and takes its first heading as the title', async () => {
    const out = await convertToMarkdown('markdown', b('﻿# Guide\r\n\r\ntext'));
    expect(out).toEqual({ markdown: '# Guide\n\ntext', title: 'Guide' });
  });
});

describe('headings from HTML', () => {
  it('lose turndown’s escapes but keep their characters', async () => {
    const md = await htmlToMarkdown('<h1>1. Introduction</h1><p>x y</p><h2>Using snake_case [beta]</h2><p>z</p>');
    const s = splitMarkdown(md, 'Doc');
    expect(s[0]!.title).toBe('1. Introduction');
    expect(s[0]!.subheadings.map((h) => h.title)).toEqual(['Using snake_case [beta]']);
  });
});
