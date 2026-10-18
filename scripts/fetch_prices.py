"""Atualiza prices.json com cotações (último preço + fecho diário dos últimos 6 meses).

Corre no GitHub Actions. Só contém dados públicos de mercado — nunca dados pessoais.
"""
import json
import datetime as dt
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (caderneta price bot)"}
SYMBOLS = {"vuaa": "VUAA.DE", "btc": "BTC-EUR", "ada": "ADA-EUR"}
COINGECKO = {"btc": "bitcoin", "ada": "cardano"}


def get_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def yahoo(symbol):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=6mo&interval=1d"
    res = get_json(url)["chart"]["result"][0]
    meta = res["meta"]
    closes = res["indicators"]["quote"][0]["close"]
    history = {}
    for ts, c in zip(res["timestamp"], closes):
        if c is not None:
            day = dt.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
            history[day] = round(c, 6)
    return {
        "price": round(meta["regularMarketPrice"], 6),
        "currency": meta.get("currency", "EUR"),
        "time": dt.datetime.utcfromtimestamp(meta["regularMarketTime"]).isoformat() + "Z",
        "history": history,
    }


def main():
    try:
        with open("prices.json") as f:
            out = json.load(f)
    except Exception:
        out = {"assets": {}}
    errors = []
    failed = set()
    for key, sym in SYMBOLS.items():
        try:
            out["assets"][key] = yahoo(sym)
        except Exception as e:  # mantém o valor anterior
            errors.append(f"{sym}: {e}")
            failed.add(key)
    # Reserva para cripto caso o Yahoo falhe
    for key, cid in COINGECKO.items():
        if key in failed or key not in out["assets"]:
            try:
                p = get_json(f"https://api.coingecko.com/api/v3/simple/price?ids={cid}&vs_currencies=eur")[cid]["eur"]
                a = out["assets"].setdefault(key, {"history": {}})
                a.update(price=p, currency="EUR", time=dt.datetime.utcnow().isoformat() + "Z")
            except Exception as e:
                errors.append(f"coingecko {cid}: {e}")
    # Ouro: GC=F (USD/onça) convertido para EUR/grama com EURUSD=X
    try:
        g, fx = yahoo("GC=F"), yahoo("EURUSD=X")
        OZ = 31.1034768
        fxh = fx["history"]
        hist = {}
        for day, usd in g["history"].items():
            prev = [d for d in fxh if d <= day]
            if prev:
                hist[day] = round(usd / fxh[max(prev)] / OZ, 4)
        out["assets"]["ouro"] = {"price": round(g["price"] / fx["price"] / OZ, 4), "currency": "EUR",
                                 "time": g["time"], "history": hist, "unit": "g"}
    except Exception as e:
        errors.append(f"ouro: {e}")
    out["updated"] = dt.datetime.utcnow().isoformat() + "Z"
    out["errors"] = errors
    with open("prices.json", "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print("ok", errors)


if __name__ == "__main__":
    main()
