import { Request, Response, NextFunction } from "express";
import { config } from "@/lib/config";
import * as authService from "./auth.service";

const REFRESH_COOKIE_NAME = "refreshToken";
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Vercel (frontend) and Render (API) sit on different domains in production,
// and a "lax" cookie is NOT sent on a cross-site fetch — so login would work
// but every later silent token refresh would silently fail. "none" (paired
// with secure, which browsers require together) fixes that; "lax" stays fine
// for same-origin local dev. clearCookie must reuse the exact same options —
// mismatched attributes make the browser treat it as a different cookie and
// silently fail to clear it.
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.NODE_ENV === "production",
  sameSite: (config.NODE_ENV === "production" ? "none" : "lax") as "none" | "lax",
};

export async function loginHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.login(req.body);

    res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, {
      ...REFRESH_COOKIE_OPTIONS,
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });

    res.json({ data: { accessToken: result.accessToken, user: result.user } });
  } catch (err) {
    next(err);
  }
}

export async function refreshHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!token) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "No refresh token" } });
    }
    const result = await authService.refresh(token);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function logoutHandler(req: Request, res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS);
  res.status(204).send();
}

export async function meHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await authService.getSessionUser(req.auth!.userId);
    res.json({ data: { user } });
  } catch (err) {
    next(err);
  }
}
