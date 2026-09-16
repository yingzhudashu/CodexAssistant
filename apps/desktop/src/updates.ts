import { gt, valid } from "semver";

export function isNewerVersion(latest: string, current: string): boolean {
  if (!valid(latest) || !valid(current))
    throw new Error("UPDATE_VERSION_INVALID");
  return gt(latest, current);
}
