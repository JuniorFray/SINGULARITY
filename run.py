import os
import sys
import subprocess
import webbrowser
import time
import asyncio

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

def check_dependencies():
    print("📦 Verificando dependências do Singularity Orquestrador...")
    req_file = os.path.join(os.path.dirname(__file__), "requirements.txt")
    if os.path.exists(req_file):
        try:
            import fastapi
            import uvicorn
            import websockets
            import pydantic
            print("✅ Dependências ativas!")
        except ImportError:
            print("⏳ Instalando dependências...")
            subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", req_file])

def main():
    check_dependencies()
    
    port = 8000
    host = "127.0.0.1"
    url = f"http://{host}:{port}"
    
    print(f"🪐 Iniciando o Singularity - Sistema Orquestrador IA em {url}...")
    
    def open_browser():
        time.sleep(1.5)
        webbrowser.open(url)
        
    import threading
    threading.Thread(target=open_browser, daemon=True).start()
    
    import uvicorn
    uvicorn.run("backend.main:app", host=host, port=port, loop="asyncio", reload=True)

if __name__ == "__main__":
    main()
