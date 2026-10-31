"""Auth endpoints (D27): signup, login, logout. Cookie-based sessions."""
from __future__ import annotations

from fastapi import APIRouter, Cookie, Response
from pydantic import BaseModel
from returns.result import Failure

from Auth import auth
from Config.Hardcoded.limits import SESSION_TTL_SECONDS

router = APIRouter(prefix="/auth", tags=["auth"])


class Credentials(BaseModel):
    username: str
    password: str


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        "dreamedia", token,
        max_age=SESSION_TTL_SECONDS, httponly=True, samesite="lax", path="/",
    )


@router.post("/signup")
async def signup(body: Credentials, response: Response):
    result = await auth.signup(body.username, body.password)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    data = result.unwrap()
    _set_cookie(response, data.pop("token"))
    return {"ok": True, **data}


@router.post("/login")
async def login(body: Credentials, response: Response):
    result = await auth.login(body.username, body.password)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    data = result.unwrap()
    _set_cookie(response, data.pop("token"))
    return {"ok": True, **data}


@router.post("/logout")
async def logout(response: Response, dreamedia: str | None = Cookie(default=None)):
    if dreamedia:
        await auth.logout(dreamedia)
    response.delete_cookie("dreamedia", path="/")
    return {"ok": True}
