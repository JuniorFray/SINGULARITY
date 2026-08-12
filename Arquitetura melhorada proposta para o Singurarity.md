markdown# Arquitetura Técnica: Orquestrador Multiagente (Claude + NVIDIA NIM)

Este documento define a estrutura arquitetural de três camadas para o orquestrador de tarefas, otimizando o consumo de APIs pagas (Claude Pro) e alavancando os modelos gratuitos de contexto massivo da NVIDIA para execução paralela resiliente, segura e imune a bloqueios de taxa de requisição.

---

## 1. Visão Geral da Topologia de Inteligência

Use o código com cuidado.┌─────────────────────────────────────────────────────────┐│         CAMADA 1: ESTRATÉGICA (Claude Pro / Pay)         │ -> Arquiteta o escopo macro└────────────────────────────┬────────────────────────────┘    e gera o contrato JSON global.│▼┌─────────────────────────────────────────────────────────┐│     CAMADA 2: GERENCIAL (DeepSeek-R1 / GLM / NVIDIA)    │ -> Consome contexto massivo (1M),└────────────────────────────┬────────────────────────────┘    gera a árvore detalhada de tarefas.│▼┌─────────────────────────────────────────────────────────┐│     CAMADA 3: OPERACIONAL (Qwen Coder / Llama / NIM)    │ -> Executa tarefas puras em paralelo.└─────────────────────────────────────────────────────────┘    Controle de vazão e Fallback (429).
---

## 2. Mapeamento de Funções e Modelos

| Camada | Papel Técnico | Modelo Principal | Modelo Fallback | Entrada (Input) | Saída (Output) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Estratégica** | Diretor Executivo | `claude-3-7-sonnet` | `claude-3-5-haiku` | Briefing do Usuário | JSON de Metas Globais |
| **2. Gerencial** | Arquiteto de Contexto | `deepseek-ai/deepseek-r1` | `z-ai/glm-5.2` | JSON Global + Código Atual | Grafo de Tarefas Atômicas |
| **3. Operacional** | Operários de Backend | `qwen/qwen-2.5-coder-32b` | `meta/llama-3.1-70b` | Tarefa Isolada + Contexto Local | Código Fonte / Teste Unitário |
| **3. Operacional** | **Equipe Gráfica / Frontend** | *Ver subseção abaixo* | *Ver subseção abaixo* | Layout / Protótipo / Prompt | Código Interface / Imagens |

### 2.1 Detalhamento da Equipe Responsável pela Parte Gráfica (Camada 3)

Esta subequipe atua de forma dedicada à interface do usuário (UI/UX), dividida em três especialidades complementares no hub da NVIDIA:

* **Operário de Frontend (Código Visual):** `qwen/qwen-2.5-coder-32b`
  * *Função:* Transforma os requisitos de interface em código real (HTML/CSS responsivo, Tailwind CSS, componentes React, Vue ou animações JavaScript puras).
* **Inspetor de Design (Visão Multimodal):** `meta/llama-3.2-11b-vision-instruct`
  * *Função:* Recebe capturas de tela (prints) das páginas geradas, analisa quebras de layout, alinhamento de botões, contraste de cores e valida regras de acessibilidade (WCAG).
* **Gerador de Assets (Design Visual):** `stabilityai/stable-diffusion-xl` (ou variantes SD 3)
  * *Função:* Cria elementos visuais sob demanda, como ícones personalizados, placeholders de imagens, logotipos conceituais e texturas de fundo a partir de texto.

---

## 3. Capacidade e Limites por Requisição (NVIDIA NIM)

Uma **requisição** é cada ciclo de envio e resposta (payload) trafegado entre seu orquestrador e a infraestrutura da NVIDIA. Para evitar desperdício de recursos, o sistema deve respeitar os seguintes limites físicos:

* **Janela de Entrada (Contexto de Entrada):** Até **1.000.000 de tokens** (~750.000 palavras). Permite enviar múltiplos arquivos de código fonte ou payloads complexos de uma só vez.
* **Janela de Saída (Geração Máxima):** Até **16.384 tokens** (~12.000 palavras de código gerado por resposta).
* **Taxa de Frequência Padrão:** **40 Requisições por Minuto (RPM)** por conta/chave.

---

## 4. Implementação do Roteador com Controle de Vazão e Fallback (Python)

Este roteador utiliza um **Semáforo Assíncrono** combinado com uma **Janela Deslizante de Tempo** configurada para **35 RPM** (margem de segurança). Se o limite de tempo estourar ou se ocorrer um erro `429`, ele rotaciona dinamicamente para a próxima conta do pool.

```python
import asyncio
import time
from typing import List, Dict, Any
from openai import AsyncOpenAI, RateLimitError

# Pool de Chaves NVIDIA (Múltiplas contas para escalabilidade massiva)
NVIDIA_KEYS_POOL: List[str] = [
    "nvapi-CONTA_PRINCIPAL_AAAAA...",
    "nvapi-CONTA_RESERVA_BBBBB...",
    "nvapi-CONTA_RESERVA_CCCCC..."
]

class ResilientNvidiaRouter:
    def __init__(self):
        self.key_index = 0
        self.base_url = "https://nvidia.com"
        
        # Controle de vazão: teto seguro de 35 requisições por minuto por chave
        self.safe_rpm_limit = 35
        self.semaphore = asyncio.Semaphore(self.safe_rpm_limit)
        self.request_timestamps: List[float] = []

    def _get_client(self) -> AsyncOpenAI:
        """Retorna um cliente assíncrono com a chave ativa do pool."""
        return AsyncOpenAI(base_url=self.base_url, api_key=NVIDIA_KEYS_POOL[self.key_index])

    async def _throttle_if_needed(self):
        """Aplica pausa inteligente (Throttling) baseada em uma janela deslizante de 60 segundos."""
        now = time.time()
        # Remove registros mais velhos que 60 segundos
        self.request_timestamps = [t for t in self.request_timestamps if now - t < 60]
        
        if len(self.request_timestamps) >= self.safe_rpm_limit:
            oldest_request = self.request_timestamps
            wait_time = 60 - (now - oldest_request)
            if wait_time > 0:
                print(f"⏳ [Vazão] Próximo ao limite da chave ({len(self.request_timestamps)}/{self.safe_rpm_limit}). Pausando por {wait_time:.2f}s...")
                await asyncio.sleep(wait_time)
        
        self.request_timestamps.append(time.time())

    async def execute_task(self, model_pipeline: List[str], messages: List[Dict[str, str]], temperature: float = 0.2) -> str:
        """
        Executa a requisição em paralelo de forma segura.
        Gerencia o tempo para não estourar os 40 RPM e rotaciona contas se necessário.
        """
        model_index = 0
        failed_keys_in_current_loop = 0

        async with self.semaphore:
            await self._throttle_if_needed()

            while model_index < len(model_pipeline):
                try:
                    client = self._get_client()
                    model = model_pipeline[model_index]
                    
                    response = await client.chat.completions.create(
                        model=model,
                        messages=messages,
                        temperature=temperature,
                        max_tokens=16384  # Teto máximo de saída por requisição
                    )
                    return response.choices.message.content

                except RateLimitError:
                    print(f"⚠️ Limite 429 atingido na conta {self.key_index}. Rotacionando credenciais...")
                    self.key_index = (self.key_index + 1) % len(NVIDIA_KEYS_POOL)
                    failed_keys_in_current_loop += 1
                    
                    # Limpa o histórico de tempo da nova chave para não travar o fluxo
                    self.request_timestamps.clear() 
                    
                    if failed_keys_in_current_loop >= len(NVIDIA_KEYS_POOL):
                        print(f"🚨 Todas as contas do pool atingiram o limite para o modelo {model}. Mudando de modelo.")
                        model_index += 1
                        failed_keys_in_current_loop = 0
                        await asyncio.sleep(2)
                    continue
                    
                except Exception as e:
                    print(f"❌ Erro crítico no modelo {model}: {str(e)}. Tentando fallback de modelo...")
                    model_index += 1
                    continue

            raise RuntimeWarning("💥 Falha Crítica: Todos os modelos e chaves do cluster falharam.")
```

---

## 5. Engenharia de Prompts e Contratos de Dados (Payloads)

### Camada 1: Prompt do Claude Pro (Gera Contrato Estruturado)
```text
Atue como o Diretor de Arquitetura de Software. Sua única função é receber o pedido do usuário e transformá-lo em uma arquitetura de dados e módulos de alto nível. Você NÃO escreve código funcional, apenas define a estrutura de pastas e as dependências entre os módulos.
Retorne estritamente um objeto JSON com a seguinte assinatura, sem blocos markdown adicionais:
{
  "project_name": "string",
  "architecture_pattern": "string",
  "modules": [
    { "id": 1, "name": "string", "description": "string", "depends_on": [] }
  ]
}
```

### Camada 2: Prompt do DeepSeek-R1 (NVIDIA - Quebra em Subtarefas Atômicas)
```text
Você é o Gerente de Projetos Técnico. Você tem acesso a uma janela de contexto de 1 milhão de tokens. Analise o JSON estruturado pelo Arquiteto e a base de código atual do projeto fornecida abaixo. 
Gere a lista exata de subtarefas técnicas (User Stories de Desenvolvimento). Cada subtarefa deve ser atômica o suficiente para ser executada por um modelo de código júnior de forma isolada, sem que ele precise conhecer o resto do sistema.
Retorne as tarefas no formato estruturado para consumo do orquestrador.
```

---

## 6. Mecanismos de Loops Automatizados Sem Custo (Auto-Healing)

### 6.1 Loop de Correção de Código (Backend)
1. **Captura do Erro:** O script intercepta o `stdout`/`stderr` do terminal (Ex: `SyntaxError` ou `AssertionError`).
2. **Avaliação Gerencial:** O erro + o código quebrado são enviados para o `z-ai/glm-5.2` (Camada 2).
3. **Instrução Corretiva:** O modelo gerencial identifica o bug e reescreve apenas o prompt de correção: *"Corrija a função X, o erro reportado pelo interpretador foi Y"*.
4. **Reexecução Operacional:** O `qwen/qwen-2.5-coder-32b` processa a correção. O processo se repete até 3 vezes a custo zero antes de escalar o problema de volta ao Claude Pro.

### 6.2 Loop de Ajuste Visual (Equipe Gráfica)
1. **Geração Inicial:** O operário `qwen/qwen-2.5-coder-32b` codifica o arquivo frontend (React/HTML/Tailwind).
2. **Renderização Automatizada:** O orquestrador usa uma ferramenta de automação (ex: *Playwright* ou *Puppeteer*) para abrir o arquivo em segundo plano e tirar um print (`.png`) da interface.
3. **Crítica de Design:** O print é enviado por API ao inspetor multimodal `meta/llama-3.2-11b-vision-instruct`.
4. **Refatoração Estética:** O Llama Vision avalia o layout. Caso detecte distorções ou problemas estéticos, envia o relatório visual direto para o Qwen Coder reajustar o CSS.
