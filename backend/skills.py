"""
backend/skills.py
Skills embutidas = presets por tipo de projeto. Cada skill injeta convenções/stack
no contexto das Camadas 1-2 (planejamento), para o plano sair sob medida.
O usuário seleciona no dropdown ao lado da caixa de mensagem.
"""
from typing import Dict, Any, List

SKILLS: Dict[str, Dict[str, Any]] = {
    "auto": {
        "name": "Auto (IA decide)",
        "icon": "🧠",
        "description": "Deixa a IA escolher a melhor abordagem pelo objetivo.",
        "guidance": "",
    },
    "web_games": {
        "name": "Jogos Web (HTML5/Canvas)",
        "icon": "🎮",
        "description": "Hub/mini-jogos em HTML5 + Canvas, JS puro, visual glassmorphism.",
        "guidance": (
            "TIPO DE PROJETO: Jogos Web (HTML5/Canvas, JavaScript puro, sem framework).\n"
            "- Cada jogo coeso (html + seu js + seu css) é UMA tarefa única do mesmo operário.\n"
            "- Siga a estrutura existente: página do jogo em games/<nome>.html, script em js/<nome>.js, "
            "estilo em css/<nome>.css; referencie a raiz com o caminho relativo CORRETO da profundidade real.\n"
            "- Visual dark/glassmorphism consistente com o hub; recordes em localStorage; responsivo (teclado + touch).\n"
            "- Ao adicionar um jogo, também insira o card no index.html via patch, preservando os jogos existentes."
        ),
    },
    "react": {
        "name": "App Web (React/Vite)",
        "icon": "⚛️",
        "description": "SPA React com Vite, componentes funcionais e hooks.",
        "guidance": (
            "TIPO DE PROJETO: App Web React (Vite). Componentes funcionais + hooks, JSX, "
            "componentização por pasta, estado com hooks/context, imports relativos corretos. "
            "Não misture com HTML/JS puro; siga os padrões de projeto React já presentes."
        ),
    },
    "python_api": {
        "name": "API Python (FastAPI)",
        "icon": "🐍",
        "description": "Backend/API em Python FastAPI, rotas REST, pydantic, async.",
        "guidance": (
            "TIPO DE PROJETO: Backend/API Python (FastAPI). Rotas REST claras, modelos pydantic, "
            "funções async, tratamento de erro com HTTPException, sem quebrar imports existentes. "
            "Escreva código idiomático e testável."
        ),
    },
    "mobile": {
        "name": "App Mobile",
        "icon": "📱",
        "description": "Mobile-first: layout responsivo, gestos de toque, PWA.",
        "guidance": (
            "TIPO DE PROJETO: App Mobile / mobile-first. Layout responsivo (mobile primeiro), "
            "alvos de toque grandes, gestos, viewport correta, PWA quando fizer sentido. "
            "Evite dependências pesadas; priorize desempenho no celular."
        ),
    },
    "refactor": {
        "name": "Refatoração / Correção",
        "icon": "🔧",
        "description": "Edições cirúrgicas por patch, preservando comportamento.",
        "guidance": (
            "TIPO DE PROJETO: Refatoração/Correção. Faça edições CIRÚRGICAS via patch, "
            "preservando o comportamento existente. NUNCA recrie arquivos do zero nem remova "
            "funcionalidades. Mudanças mínimas e localizadas, com o trecho exato a alterar."
        ),
    },
    "ui_css": {
        "name": "UI / CSS Responsivo",
        "icon": "🎨",
        "description": "Estilo, temas, responsividade e acessibilidade.",
        "guidance": (
            "TIPO DE PROJETO: UI/CSS. Foco em responsividade (breakpoints), tema consistente, "
            "acessibilidade (contraste, foco, aria) e polish visual. Altere principalmente CSS/markup, "
            "sem quebrar a lógica JS existente."
        ),
    },
    "tests": {
        "name": "Testes",
        "icon": "🧪",
        "description": "Escrever/ampliar testes sem alterar a lógica de produção.",
        "guidance": (
            "TIPO DE PROJETO: Testes. Escreva ou amplie testes automatizados cobrindo os casos "
            "relevantes. NÃO altere a lógica de produção — apenas arquivos de teste (crie novos quando preciso)."
        ),
    },
    "audit": {
        "name": "Auditoria / Review",
        "icon": "🔍",
        "description": "Somente análise e relatório — não altera arquivos.",
        "guidance": (
            "TIPO DE PROJETO: Auditoria/Review (SOMENTE LEITURA). NÃO altere código de produção. "
            "Gere um relatório de análise (bugs, riscos, melhorias). Se precisar gravar algo, grave "
            "apenas um arquivo de relatório novo (ex: RELATORIO_AUDITORIA.md)."
        ),
    },
}


def list_skills() -> List[Dict[str, str]]:
    """Lista para o dropdown da UI."""
    return [
        {"id": sid, "name": s["name"], "icon": s["icon"], "description": s["description"]}
        for sid, s in SKILLS.items()
    ]


def get_skill_guidance(skill_id: str) -> str:
    """Texto de orientação a injetar no planejamento (vazio para 'auto' ou id inválido)."""
    skill = SKILLS.get(skill_id or "auto")
    return skill["guidance"] if skill else ""
