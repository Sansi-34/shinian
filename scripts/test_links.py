"""拾念 SHINIAN · 关联记录 / 反链 / 局部图 / 导出 验收（隔离库）

运行前：
  $env:PORT="3400"
  $env:DATABASE_URL="D:\\联动日程表\\db\\test-links.sqlite"
  $env:SHINIAN_MASTER_KEY_FILE="D:\\联动日程表\\db\\test-links-master.key"
  npm run serve
运行：
  $env:SHINIAN_BASE="http://127.0.0.1:3400"; python scripts/test_links.py
"""
import json
import sys
import uuid

from common import Client, Checker

c = Checker()
uid = uuid.uuid4().hex[:6]
client = Client()
client.login("关联验收")

A_TEXT = f"【关联验收】PWM 低占空比时 LED 会闪 {uid}"
B_TEXT = f"【关联验收】把 PWM 频率提高到 2 kHz 后闪烁减轻 {uid}"
C_TEXT = f"【关联验收】另一条同主题念头 {uid}"
SAME_TEXT = f"【关联验收】同名记录 {uid}"

status, res = client.post("/api/captures", {"rawText": A_TEXT})
c.check("创建念头 A", status == 200, f"{status} {res}")
A = res["capture"]
status, res = client.post("/api/captures", {"rawText": B_TEXT})
c.check("创建念头 B", status == 200, f"{status} {res}")
B = res["capture"]
status, res = client.post("/api/captures", {"rawText": C_TEXT})
c.check("创建念头 C", status == 200, f"{status} {res}")
C = res["capture"]

# ---------- 选择列表 ----------
status, res = client.get(f"/api/capture-links/candidates?excludeId={A['id']}")
c.check("候选列表 200", status == 200, f"{status} {res}")
c.check("候选列表排除自己", all(x["id"] != A["id"] for x in res["captures"]), str(res)[:300])
c.check("候选列表带短摘要", all(x.get("summary") for x in res["captures"]), str(res)[:300])
c.check("候选列表带日期", all(isinstance(x.get("createdAt"), int) for x in res["captures"]), str(res)[:300])

status, res = client.get(f"/api/capture-links/candidates?excludeId={A['id']}&q={uid}")
c.check("候选搜索命中同批其他记录", status == 200 and len(res["captures"]) >= 2, f"{status} {len(res.get('captures', []))}")
c.check("候选搜索摘要包含关键词", any(uid in x["snippet"] for x in res["captures"]), str(res)[:300])

# 同名记录：显示摘要 + 日期，且 ID 不同
s1 = client.post("/api/captures", {"rawText": SAME_TEXT})[1]["capture"]
s2 = client.post("/api/captures", {"rawText": SAME_TEXT})[1]["capture"]
status, res = client.get(f"/api/capture-links/candidates?excludeId={A['id']}&q={SAME_TEXT[:18]}")
same_hits = [x for x in res["captures"] if x["summary"] == SAME_TEXT]
c.check("同名记录都出现在候选列表", len(same_hits) == 2, str(same_hits))
c.check("同名记录可用 ID 区分", same_hits[0]["id"] != same_hits[1]["id"], str(same_hits))
c.check("同名记录带各自日期", all(isinstance(x["createdAt"], int) for x in same_hits), str(same_hits))

# ---------- 创建关联 ----------
op1 = f"op-link-{uid}-1"
status, res = client.post(
    f"/api/captures/{A['id']}/links",
    {"toCaptureId": B["id"], "note": "同一个闪烁问题的前后两条记录", "operationId": op1},
)
c.check("A 关联 B 成功", status == 200, f"{status} {res}")
link = res.get("link") or {}
link_id = link.get("id")
c.check("关联有稳定 ID", bool(link_id), str(link))
c.check("关联保留方向 A→B", link.get("fromCaptureId") == A["id"] and link.get("toCaptureId") == B["id"], str(link))
c.check("关联说明保存", link.get("note") == "同一个闪烁问题的前后两条记录", str(link))

status, res = client.post(
    f"/api/captures/{A['id']}/links",
    {"toCaptureId": B["id"], "note": "同一个闪烁问题的前后两条记录", "operationId": op1},
)
c.check("重复提交同一 operationId 返回同一关联", status == 200 and res.get("link", {}).get("id") == link_id and res.get("replayed") is True, f"{status} {res}")

status, res = client.post(
    f"/api/captures/{A['id']}/links",
    {"toCaptureId": B["id"], "note": "", "operationId": f"op-link-{uid}-dup"},
)
c.check("同方向重复关联被拒绝 (409)", status == 409 and res.get("error") == "duplicate_link", f"{status} {res}")

status, res = client.post(
    f"/api/captures/{A['id']}/links",
    {"toCaptureId": A["id"], "operationId": f"op-link-{uid}-self"},
)
c.check("自关联被拒绝", status == 400 and res.get("error") == "self_link_not_allowed", f"{status} {res}")

status, res = client.post(
    f"/api/captures/{A['id']}/links",
    {"toCaptureId": B["id"], "note": "x" * 201, "operationId": f"op-link-{uid}-long"},
)
c.check("关联说明超过 200 字被拒绝", status == 400 and res.get("error") == "note_too_long", f"{status} {res}")

# 同 operationId 改内容
status, res = client.post(
    f"/api/captures/{A['id']}/links",
    {"toCaptureId": C["id"], "operationId": op1},
)
c.check("同一 operationId 改内容被拒绝 (409)", status == 409 and res.get("error") == "operation_key_conflict", f"{status} {res}")

# ---------- 双向读取 ----------
status, res = client.get(f"/api/captures/{A['id']}/links")
c.check("A 读取关联 200", status == 200, f"{status}")
c.check("A 显示关联到 B", any(x["capture"]["id"] == B["id"] for x in res["out"]), str(res)[:400])
c.check("A 没有反向误报", all(x["capture"]["id"] != B["id"] for x in res["in"]), str(res)[:400])

status, res_b = client.get(f"/api/captures/{B['id']}/links")
c.check("B 显示被 A 关联", any(x["capture"]["id"] == A["id"] for x in res_b["in"]), str(res_b)[:400])
c.check("反链与正链是同一关系 ID", any(x["id"] == link_id for x in res_b["in"]), str(res_b)[:400])
c.check("B 不把反链显示成正链", all(x["capture"]["id"] != A["id"] for x in res_b["out"]), str(res_b)[:400])

# ---------- 编辑正文后链接仍有效 ----------
status, res = client.patch(f"/api/captures/{A['id']}", {"rawText": A_TEXT + "（已补充）", "revision": A["revision"]})
c.check("编辑念头正文成功", status == 200, f"{status} {res}")
A = res["capture"]
status, res_b = client.get(f"/api/captures/{B['id']}/links")
in_row = next((x for x in res_b["in"] if x["id"] == link_id), None)
c.check("编辑正文后反链仍存在", in_row is not None, str(res_b)[:400])
c.check("反链显示编辑后的摘要", in_row and "已补充" in in_row["capture"]["summary"], str(in_row))
status, res = client.get(f"/api/captures/{A['id']}/links")
c.check("编辑正文后正链仍存在", any(x["id"] == link_id for x in res["out"]), str(res)[:400])

# ---------- 尝试引用汇总 ----------
status, res = client.post(
    f"/api/captures/{A['id']}/attempts",
    {"step": f"A 的尝试：比较 500Hz 与 2kHz {uid}", "state": "done", "operationId": f"op-att-{uid}-a"},
)
c.check("创建 A 的尝试", status == 200, f"{status} {res}")
A_ATT = res["attempt"]
status, res = client.patch(
    f"/api/attempts/{A_ATT['id']}",
    {"state": "done", "resultText": "500Hz 闪烁明显；2kHz 肉眼不可见", "outcome": "success", "revision": A_ATT["revision"]},
)
c.check("记录 A 尝试结果", status == 200, f"{status} {res}")
A_ATT = res["attempt"]

status, res = client.post(
    f"/api/captures/{B['id']}/attempts",
    {"step": f"B 的旧尝试：先测 1kHz {uid}", "state": "done", "operationId": f"op-att-{uid}-b"},
)
c.check("创建 B 的尝试", status == 200, f"{status} {res}")
B_ATT = res["attempt"]
status, res = client.patch(
    f"/api/attempts/{B_ATT['id']}",
    {"state": "done", "resultText": "1kHz 时仍有轻微闪烁", "outcome": "failure", "revision": B_ATT["revision"]},
)
c.check("记录 B 尝试结果", status == 200, f"{status} {res}")
B_ATT = res["attempt"]

status, res = client.post(
    f"/api/attempts/{A_ATT['id']}/references",
    {"toId": B_ATT["id"], "note": "沿用 B 的基准频率", "operationId": f"op-ref-{uid}"},
)
c.check("A 尝试引用 B 尝试", status == 200, f"{status} {res}")
REF = res["reference"]

status, res = client.get(f"/api/captures/{A['id']}/references")
c.check("A 的念头级引用 200", status == 200, f"{status}")
c.check("A 显示我参考了什么", any(x["id"] == REF["id"] for x in res["out"]), str(res)[:400])
c.check("引用快照保存实际结果", any(x["snapshotResultText"] == "1kHz 时仍有轻微闪烁" for x in res["out"]), str(res)[:400])
c.check("引用指向的念头正文可读", any(B_TEXT in x["to"]["captureText"] for x in res["out"]), str(res)[:400])

status, res = client.get(f"/api/captures/{B['id']}/references")
c.check("B 显示后来哪里用过这条结果", any(x["id"] == REF["id"] for x in res["in"]), str(res)[:400])
c.check("B 的引用列表带来源尝试", any(x["from"]["step"].startswith("A 的尝试") for x in res["in"]), str(res)[:400])

# ---------- 图谱 ----------
status, graph = client.get("/api/graph?archived=1")
c.check("图谱 200", status == 200, f"{status}")
related = [l for l in graph["links"] if l["type"] == "related"]
c.check("图谱包含手动关联边", any(l["source"] == f"capture:{A['id']}" and l["target"] == f"capture:{B['id']}" for l in related), str(related)[:400])
c.check("图谱包含引用边", any(l["type"] == "references" for l in graph["links"]), str(graph["links"])[:400])

status, local1 = client.get(f"/api/graph/focus?node=capture:{B['id']}&depth=1&archived=1")
c.check("B 局部图一跳 200", status == 200, f"{status} {local1 if status != 200 else ''}")
node_ids_1 = {n["id"] for n in local1.get("nodes", [])}
c.check("一跳包含 B 自己和 A", f"capture:{B['id']}" in node_ids_1 and f"capture:{A['id']}" in node_ids_1, str(node_ids_1))
c.check("一跳包含 B 的尝试与 A 的念头", f"attempt:{B_ATT['id']}" in node_ids_1 and f"capture:{A['id']}" in node_ids_1, str(node_ids_1))
c.check("一跳不越过 B 的尝试去连带 A 的尝试（两跳才出现）", f"attempt:{A_ATT['id']}" not in node_ids_1, str(node_ids_1))
c.check("一跳不包括两跳外的 C 念头", f"capture:{C['id']}" not in node_ids_1, str(node_ids_1))
c.check("局部图 meta 标记一跳", local1.get("meta", {}).get("depth") == 1, str(local1.get("meta")))

status, local2 = client.get(f"/api/graph/focus?node=capture:{B['id']}&depth=2&archived=1")
c.check("B 局部图两跳 200", status == 200, f"{status}")
node_ids_2 = {n["id"] for n in local2.get("nodes", [])}
c.check("两跳节点不少于一跳", node_ids_2.issuperset(node_ids_1), f"{len(node_ids_1)} -> {len(node_ids_2)}")
c.check("两跳包含 A 的尝试", f"attempt:{A_ATT['id']}" in node_ids_2, str(node_ids_2))
c.check("两跳 meta 标记 depth=2", local2.get("meta", {}).get("depth") == 2, str(local2.get("meta")))
c.check("两跳内边端点都可见", all(l["source"] in node_ids_2 and l["target"] in node_ids_2 for l in local2.get("links", [])), str(local2.get("links"))[:300])

# 超出全局展示上限的旧记录
old_ids = []
for i in range(26):
    st, rr = client.post("/api/captures", {"rawText": f"【旧记录 {i:02d}】上限测试 {uid}"})
    old_ids.append(rr["capture"]["id"])
status, limited = client.get("/api/graph?limit=20")
shown = {n["id"] for n in limited["nodes"]}
missing = [cid for cid in old_ids if f"capture:{cid}" not in shown]
c.check("全局图确实只展示有限念头", len(missing) >= 1, f"shown={len(shown)} missing={len(missing)}")
if missing:
    status, old_local = client.get(f"/api/graph/focus?node=capture:{missing[0]}&depth=1")
    c.check("超出上限的旧记录可打开局部图", status == 200 and any(n["id"] == f"capture:{missing[0]}" for n in old_local.get("nodes", [])), f"{status} {str(old_local)[:300]}")

status, res = client.get(f"/api/graph/search?q={uid}&limit=50")
c.check("图谱搜索 200", status == 200, f"{status}")
c.check("搜索能命中尝试", any(h["node"]["type"] == "attempt" for h in res["results"]), str(res)[:400])

status, res = client.get(f"/api/graph/search?q=肉眼不可见&limit=50")
result_hits = [h for h in res["results"] if h["matchField"] == "attempt.resultText"]
c.check("搜索能命中实际结果文本", len(result_hits) >= 1, str(res)[:400])
c.check("搜索结果带结果摘要", any("肉眼不可见" in h["snippet"] for h in result_hits), str(result_hits)[:400])

status, res = client.get(f"/api/graph/focus?node=attempt:{A_ATT['id']}&depth=1")
c.check("尝试局部图 200", status == 200, f"{status}")

# ---------- 归档筛选 ----------
status, res = client.post(f"/api/captures/{B['id']}/archive", {})
c.check("归档 B", status == 200, f"{status} {res}")
status, g0 = client.get("/api/graph")
c.check("默认全局图不含已归档 B", all(n["id"] != f"capture:{B['id']}" for n in g0["nodes"]), str(g0["stats"]))
status, g1 = client.get("/api/graph?archived=1")
c.check("包含归档时出现 B", any(n["id"] == f"capture:{B['id']}" for n in g1["nodes"]), str(g1["stats"]))
status, res = client.get(f"/api/graph/focus?node=capture:{B['id']}&depth=1")
c.check("未包含归档时聚焦 B 明确 404", status == 404 and res.get("error") == "node_not_found", f"{status} {res}")

# ---------- 解除关联 ----------
status, res = client.delete(f"/api/capture_links/{link_id}")
c.check("解除关联 200", status == 200 and res.get("ok") is True, f"{status} {res}")
status, res = client.get(f"/api/captures/{A['id']}/links")
c.check("解除后 A 正链消失", all(x["id"] != link_id for x in res["out"]), str(res)[:400])
status, res = client.get(f"/api/captures/{B['id']}/links")
c.check("解除后 B 反链消失", all(x["id"] != link_id for x in res["in"]), str(res)[:400])
status, res = client.delete(f"/api/capture_links/{link_id}")
c.check("重复解除返回 404", status == 404, f"{status} {res}")

# 删除记录时清理关联（A→C 新关联）
status, res = client.post(
    f"/api/captures/{A['id']}/links",
    {"toCaptureId": C["id"], "note": "删除测试", "operationId": f"op-link-{uid}-del"},
)
c.check("创建 A→C 关联", status == 200, f"{status} {res}")
del_link = res["link"]["id"]
status, preview = client.get(f"/api/captures/{C['id']}/delete-preview")
c.check("删除预览显示手动关联数", preview.get("captureLinkCount") == 1, str(preview))
status, res = client.delete(f"/api/captures/{C['id']}")
c.check("删除 C 成功", status == 200 and res.get("deletedLinks") == 1, f"{status} {res}")
status, res = client.get(f"/api/captures/{A['id']}/links")
c.check("删除后 A 不再有指向 C 的边", all(x["id"] != del_link for x in res["out"]), str(res)[:400])
status, graph = client.get("/api/graph?archived=1")
c.check("删除后图谱不再有该边", all(l["id"] != f"edge:related|capture:{A['id']}|capture:{C['id']}" for l in graph["links"]), "edge still present")

# ---------- 导出 ----------
status, payload = client.get("/api/export")
c.check("导出 200", status == 200, f"{status}")
c.check("导出 schemaVersion>=6", payload.get("schemaVersion") in (6, 7), repr(payload.get("schemaVersion")))
c.check("导出包含 captureLinks", isinstance(payload.get("data", {}).get("captureLinks"), list), str(payload.get("data", {}).keys()))
c.check("空关联也导出为空数组", payload.get("data", {}).get("captureLinks") == [], str(payload.get("data", {}).get("captureLinks")))

ok = c.report("关联记录 / 反链 / 局部图 / 导出")
sys.exit(0 if ok else 1)
