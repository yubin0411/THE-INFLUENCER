/*
 * 직접 관리하는 내용 (시그 가격표)
 *
 * 크루 · 유튜브 채널 · 게시글 · 쇼츠 · 라이브는 관리자 페이지(/admin.html)에서 관리하며
 * 등록된 유튜브 채널의 영상이 자동으로 올라오고 누적됩니다.
 *
 * 오디오 경로 예: "assets/audio/sig1.mp3"
 */
window.SITE_DATA = {
  // 시그 가격표 (등록일 기준 5일 이내면 NEW 표시). crew 는 관리자 페이지의 크루 ID
  sigs: [
    // { name: "시그 이름", crew: "crew-a", price: 1000, date: "2026-10-20", audio: "assets/audio/sig1.mp3" },
  ],
};
