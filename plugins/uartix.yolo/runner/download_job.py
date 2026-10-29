#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""官方权重下载器（P177-C）。

只做一件事：把一个**白名单主机上的 HTTPS 文件**下载到目标路径，带续传、进度、校验。
不 import ultralytics、不装包、不改配置——下载完由主进程去探针读 task/nc。

为什么是独立的 python 文件而不是让 node 直连：
- 代理/证书/重定向这些事，python 的 urllib 已经在本机环境里被验证过（用户的工作区本来就要走代理）；
- 下载是长任务，跟训练/评估一样需要“进度行 + 可取消 + 退出码”这套现成的东西；
- 宿主目前不按域名拦截网络，所以白名单必须由**下载器自己**再查一遍（`--allow-hosts`）。

输出：每行一个 JSON（面板按行读）；非 JSON 行是给人看的普通日志。
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import shutil
import signal
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CHUNK = 256 * 1024
DEFAULT_HOSTS = ["github.com", "objects.githubusercontent.com", "raw.githubusercontent.com"]
USER_AGENT = "uartix-yolo-workbench/0.5.2 (+https://github.com/Tanixs/uartix.yolo)"


def emit(**kw):
    """一行一个 JSON：主进程只认这种行，普通日志另走 stderr。"""
    sys.stdout.write(json.dumps(kw, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def note(text):
    sys.stderr.write(str(text) + "\n")
    sys.stderr.flush()


class Cancelled(Exception):
    pass


class Incomplete(Exception):
    """连接被对端掐断但 urllib 当成正常 EOF：算网络问题，可以续传重试。"""


_cancel = {"flag": False}


def _on_signal(signum, frame):  # noqa: ARG001
    _cancel["flag"] = True


def check_url(url, hosts, insecure=False):
    """HTTPS + 主机白名单。重定向的每一跳也要过这一关（见 CheckedRedirect）。

    `insecure` 只给测试用：允许 http 且只允许回环地址，生产路径不会传它。
    """
    u = urllib.parse.urlparse(url)
    host = (u.hostname or "").lower()
    local = host in ("127.0.0.1", "localhost", "::1")
    if u.scheme != "https" and not (insecure and u.scheme == "http" and local):
        raise ValueError("只接受 https:// 的下载地址（收到 %s）" % (u.scheme or "空"))
    if host not in hosts:
        raise ValueError("这个主机不在白名单里：%s（只允许 %s）" % (host or "空", "、".join(hosts)))
    return u


class CheckedRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, hosts, insecure=False):
        self.hosts = hosts
        self.insecure = insecure

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl, self.hosts, self.insecure)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def opener_for(proxy, hosts, insecure=False):
    handlers = [CheckedRedirect(hosts, insecure)]
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    else:
        # 明确不用系统代理：用户没开代理时，不要让环境变量里的半截配置改变行为
        handlers.append(urllib.request.ProxyHandler({}))
    if insecure:
        ctx = ssl._create_unverified_context()  # 仅测试：自签证书的本地服务
    else:
        ctx = ssl.create_default_context()
    handlers.append(urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(*handlers)


def human(n):
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return ("%.1f %s" % (n, unit)) if unit != "B" else ("%d B" % n)
        n /= 1024.0
    return "%.1f GB" % n


def head(url, op, timeout):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    with op.open(req, timeout=timeout) as r:
        length = r.headers.get("Content-Length")
        return int(length) if length and length.isdigit() else 0


def download_once(url, part, expect_total, op, timeout, max_bytes):
    """一次尝试。返回 (done_bytes, total_bytes)；网络错误抛 OSError/URLError。"""
    have = os.path.getsize(part) if os.path.exists(part) else 0
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    if have:
        headers["Range"] = "bytes=%d-" % have
    req = urllib.request.Request(url, headers=headers)
    with op.open(req, timeout=timeout) as r:
        status = getattr(r, "status", 200)
        total = expect_total
        if status == 206:
            cr = r.headers.get("Content-Range") or ""
            if "/" in cr:
                tail = cr.rsplit("/", 1)[1].strip()
                if tail.isdigit():
                    total = int(tail)
            mode = "ab"
        else:
            # 服务器不认 Range：从头来，已有 .part 作废
            have = 0
            mode = "wb"
            cl = r.headers.get("Content-Length")
            if cl and cl.isdigit():
                total = int(cl)
        if total and total > max_bytes:
            raise ValueError("文件 %s 超过单文件上限 %s（%s）" % (human(total), human(max_bytes), url))
        if total and not expect_total:
            emit(type="head", total=total)
        # 磁盘检查：还差多少 + 64MB 余量
        need = (total - have if total else 0) + 64 * 1024 * 1024
        free = shutil.disk_usage(os.path.dirname(os.path.abspath(part))).free
        if need > free:
            raise ValueError("磁盘空间不够：还需要 %s，只剩 %s" % (human(need), human(free)))

        done = have
        last_emit = 0.0
        t0 = time.time()
        base = have
        with open(part, mode) as f:
            while True:
                if _cancel["flag"]:
                    raise Cancelled()
                chunk = r.read(CHUNK)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total and done > total:
                    raise ValueError("服务器给的数据比声明的多（%d > %d）" % (done, total))
                now = time.time()
                if now - last_emit >= 0.4:
                    last_emit = now
                    elapsed = max(0.001, now - t0)
                    speed = int((done - base) / elapsed)
                    pct = round(done * 100.0 / total, 1) if total else 0
                    emit(type="progress", done=done, total=total or 0, pct=pct, speed=speed)
        pct = round(done * 100.0 / total, 1) if total else 0
        emit(type="progress", done=done, total=total or done, pct=pct, speed=0)
        if total and done != total:
            # 对端提前关闭：urllib 不报错，只是读到 EOF。必须自己发现，否则会拿半个文件去 rename
            raise Incomplete("连接提前结束：%d / %d 字节" % (done, total))
        return done, total


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while True:
            b = f.read(CHUNK)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser(description="下载官方 YOLO 权重（HTTPS + 白名单 + 续传）")
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True, help="最终路径；下载过程写 <out>.part")
    ap.add_argument("--expect-bytes", type=int, default=0)
    ap.add_argument("--expect-sha256", default="")
    ap.add_argument("--max-bytes", type=int, default=200 * 1024 * 1024)
    ap.add_argument("--proxy", default="")
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--allow-hosts", default=",".join(DEFAULT_HOSTS))
    ap.add_argument("--insecure", action="store_true", help="仅测试用：允许回环 http 与自签证书")
    args = ap.parse_args(argv)

    hosts = [h.strip().lower() for h in str(args.allow_hosts).split(",") if h.strip()]
    out = os.path.abspath(args.out)
    part = out + ".part"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    signal.signal(signal.SIGINT, _on_signal)
    try:
        signal.signal(signal.SIGTERM, _on_signal)
    except (AttributeError, ValueError):
        pass

    try:
        check_url(args.url, hosts, args.insecure)
    except ValueError as e:
        emit(type="error", message=str(e))
        return 2

    if args.expect_bytes and os.path.exists(out) and os.path.getsize(out) == args.expect_bytes:
        emit(type="done", ok=True, path=out, bytes=args.expect_bytes, sha256=sha256_file(out), skipped=True)
        return 0

    op = opener_for(args.proxy, hosts, args.insecure)
    total = args.expect_bytes or 0
    if not total:
        try:
            total = head(args.url, op, args.timeout)
            if total:
                emit(type="head", total=total)
        except Exception as e:  # HEAD 不支持不算错，下载时再拿 Content-Length
            note("HEAD 没取到大小（%s），继续下载" % e)

    attempt = 0
    last_err = ""
    while attempt <= max(0, args.retries):
        try:
            done, total2 = download_once(args.url, part, total, op, args.timeout, args.max_bytes)
            total = total2 or done
            if _cancel["flag"]:
                raise Cancelled()
            digest = sha256_file(part)
            if args.expect_sha256 and digest.lower() != args.expect_sha256.lower():
                raise ValueError("SHA256 不符：期望 %s，实际 %s" % (args.expect_sha256[:16], digest[:16]))
            os.replace(part, out)
            emit(type="done", ok=True, path=out, bytes=done, sha256=digest, total=total)
            return 0
        except Cancelled:
            emit(type="cancelled", message="已取消；.part 保留，下次可以续传")
            return 130
        except urllib.error.HTTPError as e:
            # 404/403 这类重试也没用：直接报，别让用户等三次
            emit(type="error", message="服务器返回 %s %s（%s）" % (e.code, e.reason, args.url))
            return 3
        except (urllib.error.URLError, socket.timeout, ConnectionResetError, TimeoutError, OSError, http.client.HTTPException, Incomplete) as e:
            last_err = str(e)
        except ValueError as e:
            # 校验/上限/磁盘：重试没有意义
            emit(type="error", message=str(e))
            return 3
        attempt += 1
        if attempt <= args.retries:
            emit(type="retry", attempt=attempt, error=last_err[:200])
            note("第 %d 次失败：%s；1 秒后重试（.part 保留）" % (attempt, last_err[:200]))
            time.sleep(1.0)
    emit(type="error", message="下载失败（已重试 %d 次）：%s" % (args.retries, last_err[:300]))
    return 4


if __name__ == "__main__":
    sys.exit(main())
