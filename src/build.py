s=open('src/shell.html').read()
core=open('src/core.js').read().replace("if (typeof module !== 'undefined') module.exports = Core;\n","")
s=s.replace('\n/*CORE*/\n','\n'+core).replace('\n/*APP*/\n','\n'+open('src/app.js').read())
open('index.html','w').write(s)
import subprocess
open('/tmp/paibao_all.js','w').write(core+'\n'+open('src/app.js').read())
r=subprocess.run(['node','--check','/tmp/paibao_all.js'],capture_output=True,text=True)
print('SYNTAX_OK' if r.returncode==0 else r.stderr[:2000], len(s))
