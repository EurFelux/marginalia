/** agent:set-avatar 结果（判别联合）：成功带新 blobId；其余为分支原因（渲染层据此 toast）。 */
export type AvatarPickResult =
  | { status: "set"; blobId: string }
  | { status: "too-large" }
  | { status: "unsupported" };
