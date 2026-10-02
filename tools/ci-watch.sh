#!/usr/bin/env bash
# 监控 GitHub Actions 构建（v1.1.48 三平台），轮询至全部 job 结束或超时。
# 用法：bash tools/ci-watch.sh [run_id] [最大等待秒数]
RUN_ID="${1:-36958704565}"
MAX_SEC="${2:-3000}"
REPO="nvhai7788-gfys/gfys"
NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
INTERVAL=60
START=$(date +%s)

echo "监控 run=$RUN_ID（最长 ${MAX_SEC}s，每 ${INTERVAL}s 查一次）"

while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START))
  if [ "$ELAPSED" -ge "$MAX_SEC" ]; then
    echo "[TIMEOUT] 已等待 ${ELAPSED}s，仍未全部结束"
    break
  fi

  JOBS=$(curl -s -m 30 "https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/jobs")
  SUMMARY=$(echo "$JOBS" | "$NODE" -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{
        const j=JSON.parse(s); const jobs=j.jobs||[];
        if(!jobs.length){console.log('NOJOBS');return;}
        let done=0;
        jobs.forEach(x=>{
          const st=(x.status==='completed')?(x.conclusion||'?'):x.status;
          if(x.status==='completed') done++;
          console.log('  ['+st+'] '+x.name);
        });
        console.log('DONE='+done+'/'+jobs.length);
      }catch(e){ console.log('PARSE_ERR'); }
    });
  ")

  echo "--- t=${ELAPSED}s ---"
  echo "$SUMMARY"

  if echo "$SUMMARY" | grep -q "^DONE=" ; then
    TOTAL=$(echo "$SUMMARY" | grep "^DONE=" | sed 's|DONE=||;s|/.*||')
    CNT=$(echo "$SUMMARY" | grep -c '^  \[')
    if [ "$TOTAL" = "$CNT" ]; then
      echo "[ALL DONE] 全部 job 结束"
      break
    fi
  fi

  sleep "$INTERVAL"
done

echo ""
echo "=== 最终状态 ==="
curl -s -m 30 "https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}" | "$NODE" -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    try{const r=JSON.parse(s);
      console.log('run: '+r.name+' #'+r.run_number+'  status='+r.status+'  conclusion='+(r.conclusion||'-'));
      console.log('html_url: '+r.html_url);
    }catch(e){console.log('ERR');}
  });
"
