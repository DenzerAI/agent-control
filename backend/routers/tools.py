"""Tool Broker API routes.

This is the first Agent-Control-owned tool surface. It only exposes safe
read-only tools for now; write, shell, network, and external actions come later
behind explicit approval flows.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import JSONResponse

from tools.approvals import decide_tool_approval, execute_tool_approval, list_tool_approvals
from tools import ToolRequest, execute_tool, list_tools
from tools.gateway import create_tool_window, direct_tool_run_allowed, execute_with_capability, gateway_required_response, mint_capability

router = APIRouter()


@router.get("/api/tools")
async def tools_catalog():
    tools = list_tools()
    categories: dict[str, int] = {}
    statuses: dict[str, int] = {}
    for tool in tools:
        categories[tool.get("category", "")] = categories.get(tool.get("category", ""), 0) + 1
        statuses[tool.get("status", "")] = statuses.get(tool.get("status", ""), 0) + 1
    return JSONResponse({
        "tools": tools,
        "count": len(tools),
        "categories": categories,
        "statuses": statuses,
    })


@router.post("/api/tools/run")
async def tools_run(payload: dict[str, Any] = Body(default_factory=dict)):
    if not direct_tool_run_allowed():
        return JSONResponse(gateway_required_response(), status_code=400)
    request = ToolRequest(
        name=str(payload.get("name") or ""),
        arguments=payload.get("arguments") if isinstance(payload.get("arguments"), dict) else {},
        agent=str(payload.get("agent") or "main"),
        project=str(payload.get("project") or ""),
        conversation_id=str(payload.get("conversation_id") or payload.get("conversationId") or ""),
        requested_by="direct-api",
        request_id=str(payload.get("request_id") or payload.get("requestId") or ""),
        policy_mode=str(payload.get("policy_mode") or payload.get("policyMode") or "user-free"),
    )
    result = execute_tool(request)
    status = 200 if result.ok else (202 if result.decision == "ask" else 400)
    return JSONResponse(result.to_dict(), status_code=status)


@router.post("/api/tools/window")
async def tools_window(payload: dict[str, Any] = Body(default_factory=dict)):
    requested_tools = payload.get("requested_tools") or payload.get("requestedTools") or []
    if not isinstance(requested_tools, list):
        requested_tools = []
    return JSONResponse(create_tool_window(
        purpose=str(payload.get("purpose") or "inspect"),
        requested_tools=[str(item) for item in requested_tools],
        include_planned=bool(payload.get("include_planned") or payload.get("includePlanned")),
        max_tools=int(payload.get("max_tools") or payload.get("maxTools") or 12),
    ))


@router.post("/api/tools/capability")
async def tools_capability(payload: dict[str, Any] = Body(default_factory=dict)):
    try:
        token = mint_capability(
            tool_name=str(payload.get("name") or payload.get("tool") or ""),
            arguments=payload.get("arguments") if isinstance(payload.get("arguments"), dict) else {},
            purpose=str(payload.get("purpose") or "inspect"),
            conversation_id=str(payload.get("conversation_id") or payload.get("conversationId") or ""),
            requested_by="gateway",
            ttl_seconds=int(payload.get("ttl_seconds") or payload.get("ttlSeconds") or 120),
        )
    except PermissionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return JSONResponse(token)


@router.post("/api/tools/gateway-run")
async def tools_gateway_run(payload: dict[str, Any] = Body(default_factory=dict)):
    try:
        result = execute_with_capability(
            capability=str(payload.get("capability") or ""),
            tool_name=str(payload.get("name") or payload.get("tool") or ""),
            arguments=payload.get("arguments") if isinstance(payload.get("arguments"), dict) else {},
            purpose=str(payload.get("purpose") or "inspect"),
            agent=str(payload.get("agent") or "main"),
            project=str(payload.get("project") or ""),
            conversation_id=str(payload.get("conversation_id") or payload.get("conversationId") or ""),
            policy_mode=str(payload.get("policy_mode") or payload.get("policyMode") or "user-free"),
        )
    except PermissionError as exc:
        return JSONResponse({"ok": False, "decision": "deny", "error": str(exc)}, status_code=400)
    status = 200 if result.ok else (202 if result.decision == "ask" else 400)
    return JSONResponse(result.to_dict(), status_code=status)


@router.get("/api/tools/approvals")
async def tools_approvals(
    status: str = Query(default="pending"),
    limit: int = Query(default=50, ge=1, le=200),
):
    approvals = list_tool_approvals(status=status, limit=limit)
    return JSONResponse({
        "approvals": approvals,
        "count": len(approvals),
        "status": status,
    })


@router.post("/api/tools/approvals/{approval_id}/decision")
async def tools_approval_decision(approval_id: int, payload: dict[str, Any] = Body(default_factory=dict)):
    execute_after_approval = bool(payload.get("execute") or payload.get("execute_after_approval") or payload.get("executeAfterApproval"))
    try:
        approval = decide_tool_approval(
            approval_id=approval_id,
            decision=str(payload.get("decision") or ""),
            decided_by=str(payload.get("decided_by") or payload.get("decidedBy") or "human"),
            note=str(payload.get("note") or ""),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if approval is None:
        raise HTTPException(status_code=404, detail="approval_not_found")
    execution = None
    if approval.get("status") == "approved" and execute_after_approval:
        try:
            execution = execute_tool_approval(
                approval_id=approval_id,
                executed_by=str(payload.get("decided_by") or payload.get("decidedBy") or "human"),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        approval = execution or approval
    return JSONResponse({"approval": approval, "execution": execution})
