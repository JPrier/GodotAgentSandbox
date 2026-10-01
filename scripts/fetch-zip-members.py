#!/usr/bin/env python3
"""Download only selected files out of a remote .zip/.tpz using HTTP range requests.

Godot's export template archive is ~1.2 GB, but the web templates are ~90 MB of it.
Usage: fetch-zip-members.py <url> <dest_dir> <glob> [<glob> ...]
Falls back to a full download if the server ignores Range requests.
"""
import fnmatch
import io
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile


def resolve(url):
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req) as r:
        return r.geturl(), int(r.headers.get("Content-Length", 0)), r.headers.get("Accept-Ranges", "")


class RangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP Range requests, with a small read-ahead cache."""

    def __init__(self, url, size, chunk=4 << 20):
        self.url, self.size, self.pos, self.chunk = url, size, 0, chunk
        self.cache_start, self.cache = -1, b""

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = {0: off, 1: self.pos + off, 2: self.size + off}[whence]
        return self.pos

    def _fetch(self, start, end):
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}"})
        with urllib.request.urlopen(req) as r:
            if r.status != 206:
                raise IOError("server ignored Range request")
            return r.read()

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        cs, ce = self.cache_start, self.cache_start + len(self.cache)
        if not (cs <= self.pos and self.pos + n <= ce):
            want = max(n, self.chunk)
            end = min(self.size - 1, self.pos + want - 1)
            self.cache = self._fetch(self.pos, end)
            self.cache_start = self.pos
        off = self.pos - self.cache_start
        data = self.cache[off:off + n]
        self.pos += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


def extract(zf, dest, patterns):
    os.makedirs(dest, exist_ok=True)
    got = []
    for info in zf.infolist():
        name = info.filename
        base = os.path.basename(name)
        if not base or not any(fnmatch.fnmatch(name, p) or fnmatch.fnmatch(base, p) for p in patterns):
            continue
        with zf.open(info) as src, open(os.path.join(dest, base), "wb") as dst:
            shutil.copyfileobj(src, dst, 1 << 20)
        got.append(base)
        print(f"  extracted {base} ({info.file_size // 1024} KiB)", flush=True)
    return got


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    url, dest, patterns = sys.argv[1], sys.argv[2], sys.argv[3:]
    final_url, size, ranges = resolve(url)
    try:
        if not size or "bytes" not in ranges.lower():
            raise IOError("no range support advertised")
        got = extract(zipfile.ZipFile(io.BufferedReader(RangeFile(final_url, size), 1 << 20)), dest, patterns)
    except Exception as e:  # full download fallback
        print(f"  range download unavailable ({e}); downloading the whole archive…", flush=True)
        with tempfile.NamedTemporaryFile(suffix=".zip") as tmp:
            with urllib.request.urlopen(url) as r:
                shutil.copyfileobj(r, tmp, 1 << 20)
            tmp.flush()
            got = extract(zipfile.ZipFile(tmp.name), dest, patterns)
    if not got:
        sys.exit(f"no members matched {patterns}")


if __name__ == "__main__":
    main()
