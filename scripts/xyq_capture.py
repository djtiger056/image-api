"""mitmproxy addon - 拦截 xyq API 请求并保存到文件"""
import json
import os
from datetime import datetime

LOG_FILE = os.path.join(os.path.dirname(__file__), "xyq_requests.jsonl")

def request(flow):
    """捕获所有发送到 xyq.jianying.com 的请求"""
    host = flow.request.pretty_host
    if "xyq.jianying.com" not in host:
        return
    
    entry = {
        "timestamp": datetime.now().isoformat(),
        "method": flow.request.method,
        "url": flow.request.pretty_url,
        "path": flow.request.path,
        "headers": dict(flow.request.headers),
        "body": None,
    }
    
    # 解析请求体
    if flow.request.content:
        try:
            entry["body"] = json.loads(flow.request.content.decode("utf-8"))
        except:
            entry["body"] = flow.request.content.decode("utf-8", errors="replace")[:2000]
    
    # 写入日志文件
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    
    # 控制台输出摘要
    body_summary = ""
    if isinstance(entry["body"], dict):
        msg = entry["body"].get("message", {})
        content = msg.get("content", [])
        agent = entry["body"].get("agent_name", "")
        if content:
            for c in content:
                d = c.get("data", "")
                if isinstance(d, str) and len(d) < 200:
                    body_summary += f" content={d[:100]}"
        body_summary = f" agent={agent}{body_summary}"
    
    print(f"[XYQ] {flow.request.method} {flow.request.path}{body_summary}")

def response(flow):
    """记录响应"""
    host = flow.request.pretty_host
    if "xyq.jianying.com" not in host:
        return
    
    if flow.response and flow.response.content:
        try:
            resp = json.loads(flow.response.content.decode("utf-8"))
            ret = resp.get("ret", "?")
            errmsg = resp.get("errmsg", "")
            if flow.request.path.endswith("submit_run"):
                with open(LOG_FILE, "a", encoding="utf-8") as f:
                    f.write(json.dumps({
                        "timestamp": datetime.now().isoformat(),
                        "type": "response",
                        "url": flow.request.pretty_url,
                        "ret": ret,
                        "errmsg": errmsg,
                        "data_preview": str(resp.get("data", ""))[:500],
                    }, ensure_ascii=False, default=str) + "\n")
                print(f"[XYQ RESPONSE] ret={ret} errmsg={errmsg}")
        except:
            pass
