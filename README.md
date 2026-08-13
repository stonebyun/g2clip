# g2clip
KangResearchCapture. 웹페이지, ChatGPT, Claude, 논문, 뉴스에서  중요한 문장을 드래그한 뒤 우클릭하면  다음 정보가 자동 저장
==> 웹, AI 대화등에서 문장을 저장, 프로젝트별 관리
-------------------------------------------

'clips' table schema
====================

id            uuid
user_id       uuid
title         text
url           text
text          text
project       text
tags          text[]
memo          text
importance    int2
favorite      boolean
created_at    timestamptz
updated_at    timestamptz
device_id     text
sync_status   text
version       int4
