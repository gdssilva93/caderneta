# Caderneta

PWA pessoal de património. Abre no Safari do iPhone → Partilhar → **Adicionar ao ecrã principal**.

- **Os dados pessoais não estão neste repositório.** Ficam só no dispositivo (localStorage), importados de um ficheiro JSON.
- `prices.json` é atualizado de 2 em 2 horas pelo GitHub Actions (`scripts/fetch_prices.py`) com cotações públicas (VUAA.DE, BTC-EUR, ADA-EUR).
- Regras automáticas ao abrir: compra VUAA (dia 4, dia útil), compra BTC (dia útil a seguir ao dia 1), subscrição Série F (dia 1), resgates IRS (31/08) e Crédito Avô (31/12), amortização do crédito habitação (fim do mês).
