# THE-INFLUENCER

(주) 이터널 사이트와 관리자 페이지입니다. Node.js 24 이상에서 추가 설치 없이 실행됩니다.

```bash
node server.js        # http://localhost:8000
```

## 설정 (환경변수 또는 `.env`)

| 이름 | 설명 |
|---|---|
| `YOUTUBE_API_KEY` | 유튜브 Data API 키 |
| `ADMIN_ID`, `ADMIN_PASSWORD` | 처음 실행할 때 만들 관리자 계정 (관리자가 이미 있으면 무시) |
| `PORT` | 포트 (기본 8000) |
| `DATA_DIR` | 데이터 폴더 (기본: Railway 볼륨, 없으면 `data/`) |

데이터베이스와 올린 파일은 데이터 폴더에 저장되며 git 에는 올라가지 않습니다.
관리자 페이지 → **내 계정 → 백업 받기** 로 정기적으로 백업하세요.

## Railway 에 올리기

1. [railway.com](https://railway.com) 에 GitHub 계정으로 로그인 → **New Project → Deploy from GitHub repo** → 이 저장소 선택
2. 서비스의 **Variables** 에 `YOUTUBE_API_KEY`, `ADMIN_ID`, `ADMIN_PASSWORD` 추가
3. 서비스에 **Volume** 추가 (Mount path: `/data`) — 이게 없으면 다시 배포할 때마다 데이터가 지워집니다
4. **Settings → Networking → Generate Domain** 으로 주소 만들기 (`○○.up.railway.app`)
5. 그 주소의 `/admin.html` 에서 2번의 관리자 계정으로 로그인 → **내 계정 → 백업 파일로 복원** 에 기존 서버에서 받은 백업 파일 올리기

### Cloudflare 도메인 연결

1. Cloudflare Pages 프로젝트에 연결된 도메인이 있으면 먼저 해제
2. Railway **Settings → Networking → Custom Domain** 에 도메인 입력 → 안내되는 CNAME 값을 확인
3. Cloudflare **DNS** 에 CNAME 레코드 추가, 프록시 상태는 **DNS only (회색 구름)**
   - 주황 구름(프록시)이면 Cloudflare 무료 요금제의 업로드 제한(100MB) 때문에 큰 레슨 영상을 올릴 수 없습니다
