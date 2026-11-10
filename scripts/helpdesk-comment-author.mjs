// Resolve the current Helpdesk profile before posting a comment. Return only
// public author fields; member responses can also contain private credentials.
export async function getHelpdeskCommentAuthor(get, memberId) {
  const data = await get("/members?limit=1000");
  const member = data?.members?.find((candidate) => candidate.id === memberId);
  if (!member) throw new Error("Không tìm thấy tài khoản Helpdesk để lấy avatar; chưa đăng comment.");

  const displayName = String(member.displayName || "").trim();
  const photoURL = String(member.photoURL || "").trim();
  if (!displayName || !/^https?:\/\//i.test(photoURL)) {
    throw new Error("Tài khoản Helpdesk thiếu tên hoặc avatar hợp lệ; chưa đăng comment.");
  }
  return { memberId: member.id, displayName, photoURL };
}
