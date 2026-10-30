import subprocess,json,socket
from pathlib import Path
r=subprocess.run(['/usr/bin/curl','-I','-sS','--http2','--max-time','20','https://api.anthropic.com'],capture_output=True,text=True)
p=Path(__file__).with_suffix('.json')
p.write_text(json.dumps({'exit_code':r.returncode,'headers':r.stdout,'error':r.stderr,'addresses':sorted({x[4][0] for x in socket.getaddrinfo('api.anthropic.com',443,type=socket.SOCK_STREAM)})},indent=2)+'\n')
