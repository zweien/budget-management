#!/usr/bin/env python3
"""预算系统 API 助手(budget-ops skill 随附)。

仅 Python 3 标准库,无 curl/jq/第三方包依赖;Windows / Linux / macOS 通用。
面向 coding agent:在客户端按 SKILL.md 的操作目录构造调用,免 shell 引号拼接。

用法:
  python budget.py setup                          # 交互式初始化(写 ~/.budget-agent.json 并自检)
  python budget.py doctor                         # 自检:连通性 + 凭证有效性
  python budget.py api METHOD PATH [JSON_BODY]    # 通用调用,如 api GET "/projects?includeArchived=1"
  python budget.py upload FILE PATH               # multipart 上传(字段名 file),用于导入解析
选项:
  --insecure        跳过 TLS 证书校验(内网自签 https);env BUDGET_INSECURE=1 同效
  --timeout N       请求超时秒数(默认 30)

配置解析顺序:BUDGET_BASE_URL / BUDGET_TOKEN 环境变量 > 配置文件(路径取
BUDGET_CONFIG,缺省 ~/.budget-agent.json;Windows 即 %USERPROFILE%\\.budget-agent.json)。

退出码:0 成功;1 本地/连通性错误;2 API 返回非 2xx(响应体已打印,含服务端
401/403/422 的业务消息,语义见 SKILL.md §1)。
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

DEFAULT_TIMEOUT = 30

# Windows 控制台默认 GBK,直打中文 JSON 可能 UnicodeEncodeError;统一转 UTF-8 并容错。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def config_path() -> Path:
    return Path(os.environ.get("BUDGET_CONFIG") or Path.home() / ".budget-agent.json")


def load_config() -> tuple[str, str]:
    """返回 (base_url, token);环境变量优先于配置文件,两者皆缺则报错退出。"""
    base_url = os.environ.get("BUDGET_BASE_URL") or ""
    token = os.environ.get("BUDGET_TOKEN") or ""
    if not (base_url and token):
        try:
            raw = json.loads(config_path().read_text(encoding="utf-8"))
            base_url = base_url or str(raw.get("baseUrl") or "")
            token = token or str(raw.get("token") or "")
        except (OSError, ValueError):
            pass
    if not (base_url and token):
        sys.exit(
            f"缺少凭据:未设置 BUDGET_BASE_URL/BUDGET_TOKEN,且 {config_path()} 不可用或缺字段。\n"
            "先运行: python budget.py setup"
        )
    return base_url.rstrip("/"), token


def request(
    method: str,
    base_url: str,
    token: str,
    path: str,
    *,
    body: bytes | None = None,
    content_type: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    insecure: bool = False,
) -> tuple[int, bytes]:
    """发一次请求,返回 (status, body)。非 2xx 不抛异常,交由调用方打印。"""
    url = base_url + path if path.startswith("/") else f"{base_url}/{path}"
    req = urllib.request.Request(url, data=body, method=method.upper())
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if content_type:
        req.add_header("Content-Type", content_type)
    ctx = ssl._create_unverified_context() if insecure else None
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        # HTTPError 是 URLError/OSError 的子类,必须在此拦下转成 (status, body),
        # 否则 4xx/5xx 会被上层误报为连接异常。异常对象自身可读响应体。
        return e.code, e.read()


def call_and_print(args: argparse.Namespace, method: str, path: str, body=None, content_type=None) -> int:
    base_url, token = load_config()
    # SKILL.md 操作目录的路径一律省略 /api 前缀(与 MCP server 同口径),此处统一拼上。
    api_path = path if path.startswith("/api/") else f"/api{'' if path.startswith('/') else '/'}{path}"
    try:
        status, data = request(
            method, base_url, token, api_path,
            body=body, content_type=content_type,
            timeout=args.timeout, insecure=args.insecure,
        )
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        print(f"❌ 无法连接 {base_url}{api_path}: {reason}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"❌ 请求失败: {e}", file=sys.stderr)
        return 1
    text = data.decode("utf-8", errors="replace")
    if status >= 300:
        print(f"HTTP {status} {path}", file=sys.stderr)
        print(text)
        return 2
    print_pretty(text)
    return 0


def print_pretty(text: str) -> None:
    try:
        print(json.dumps(json.loads(text), ensure_ascii=False, indent=2))
    except ValueError:
        print(text)


def cmd_setup(args: argparse.Namespace) -> int:
    existing = ""
    try:
        existing = str(json.loads(config_path().read_text(encoding="utf-8")).get("baseUrl") or "")
    except (OSError, ValueError):
        pass
    default = existing or os.environ.get("BUDGET_BASE_URL") or "http://"
    base_url = (input(f"Base URL [{default}]: ").strip() or default).rstrip("/")
    token = getpass.getpass("API Key (bma_…,输入不回显): ").strip()
    if not token.startswith("bma_"):
        print("⚠️ 凭证通常以 bma_ 开头,请确认没有复制多余字符。", file=sys.stderr)
    if not base_url.startswith(("http://", "https://")):
        print("❌ Base URL 须以 http:// 或 https:// 开头。", file=sys.stderr)
        return 1

    print("探测 /api/health …")
    try:
        status, data = request("GET", base_url, "", "/api/health", timeout=args.timeout, insecure=args.insecure)
        if status != 200 or b'"ok"' not in data:
            print(f"❌ 健康检查异常: HTTP {status} {data.decode('utf-8', errors='replace')[:200]}", file=sys.stderr)
            return 1
    except (urllib.error.URLError, OSError) as e:
        print(f"❌ 无法连接 {base_url}: {getattr(e, 'reason', e)}", file=sys.stderr)
        return 1

    print("校验凭证(GET /projects)…")
    try:
        status, data = request("GET", base_url, token, "/api/projects", timeout=args.timeout, insecure=args.insecure)
    except (urllib.error.URLError, OSError) as e:
        print(f"❌ 请求失败: {getattr(e, 'reason', e)}", file=sys.stderr)
        return 1
    if status != 200:
        print(f"❌ 凭证校验失败: HTTP {status} {data.decode('utf-8', errors='replace')[:200]}", file=sys.stderr)
        print("   401=凭证无效/撤销/过期,请在「API 凭证」页重发后重试。", file=sys.stderr)
        return 2

    path = config_path()
    path.write_text(json.dumps({"baseUrl": base_url, "token": token}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)  # Windows 上仅切换只读位,尽力而为
    except OSError:
        pass
    print(f"✅ 配置已写入 {path}(连通性与凭证均通过校验)")
    print("备选通道(无配置文件的环境可改用环境变量):")
    print(f'  export BUDGET_BASE_URL="{base_url}"')
    print(f'  export BUDGET_TOKEN="{token}"')
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    base_url, token = load_config()
    print(f"配置: {base_url}({os.environ.get('BUDGET_BASE_URL') and '环境变量' or config_path()})")
    ok = True
    try:
        status, data = request("GET", base_url, "", "/api/health", timeout=args.timeout, insecure=args.insecure)
        healthy = status == 200 and b'"ok"' in data
        print(f" /api/health: {'✅' if healthy else f'❌ HTTP {status}'}")
        ok &= healthy
    except (urllib.error.URLError, OSError) as e:
        print(f" /api/health: ❌ {getattr(e, 'reason', e)}")
        ok = False
    try:
        status, data = request("GET", base_url, token, "/api/projects", timeout=args.timeout, insecure=args.insecure)
        print(f" 凭证(GET /projects): {'✅ 有效' if status == 200 else f'❌ HTTP {status} ' + data.decode('utf-8', errors='replace')[:120]}")
        ok &= status == 200
    except (urllib.error.URLError, OSError) as e:
        print(f" 凭证: ❌ {getattr(e, 'reason', e)}")
        ok = False
    return 0 if ok else 1


def multipart(field: str, filename: str, data: bytes) -> tuple[bytes, str]:
    boundary = f"----budgetpy{uuid.uuid4().hex}"
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    return head + data + f"\r\n--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def main() -> int:
    parser = argparse.ArgumentParser(description="预算系统 API 助手(详见 SKILL.md)")
    parser.add_argument("--insecure", action="store_true", help="跳过 TLS 证书校验(自签 https)")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="请求超时秒数")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("setup", help="交互式初始化配置并自检")
    sub.add_parser("doctor", help="自检连通性与凭证")

    p_api = sub.add_parser("api", help="通用 REST 调用")
    p_api.add_argument("method", help="GET/POST/PATCH/DELETE …")
    p_api.add_argument("path", help='/api 下的路径,如 "/projects?includeArchived=1"')
    p_api.add_argument("body", nargs="?", help="可选 JSON 请求体字符串")

    p_up = sub.add_parser("upload", help="multipart 文件上传(字段 file)")
    p_up.add_argument("file", help="本地文件路径(.xlsx)")
    p_up.add_argument("path", help='/api 下的目标路径,如 "/projects/<ID>/imports"')

    args = parser.parse_args()
    args.insecure = args.insecure or os.environ.get("BUDGET_INSECURE") == "1"
    if args.cmd == "setup":
        return cmd_setup(args)
    if args.cmd == "doctor":
        return cmd_doctor(args)
    if args.cmd == "api":
        body, ctype = None, None
        if args.body is not None:
            try:
                body = json.dumps(json.loads(args.body), ensure_ascii=False).encode()
            except ValueError:
                print("❌ 请求体不是合法 JSON。", file=sys.stderr)
                return 1
            ctype = "application/json"
        return call_and_print(args, args.method, args.path, body, ctype)
    # upload
    f = Path(args.file).expanduser()
    try:
        data = f.read_bytes()
    except OSError as e:
        print(f"❌ 读取文件失败: {e}", file=sys.stderr)
        return 1
    body, ctype = multipart("file", f.name, data)
    return call_and_print(args, "POST", args.path, body, ctype)


if __name__ == "__main__":
    sys.exit(main())
