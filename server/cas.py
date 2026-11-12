"""SymPy worker for the tutor's math-checking tools.

Reads one JSON request per line on stdin, writes one JSON response per line on stdout.
Requests: {"id": n, "op": "evaluate", "expression": str}
          {"id": n, "op": "check_equal", "a": str, "b": str, "variables": [str] | null}
"""
import json
import random
import sys

try:
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (1 << 30, 1 << 30))  # 1 GB
except Exception:
    pass

import sympy
from sympy.parsing.sympy_parser import (
    convert_xor,
    implicit_multiplication_application,
    parse_expr,
    standard_transformations,
)

NS = {k: getattr(sympy, k) for k in dir(sympy) if not k.startswith("_")}
NS["__builtins__"] = {}
for name in "abcdfghjklmnpqrstuvwxyz":  # common single-letter symbols (E, I, N, O, Q, S reserved)
    NS.setdefault(name, sympy.Symbol(name))
for name in ("theta", "phi", "rho", "alpha", "beta", "gamma", "omega", "lam", "mu", "sigma", "tau"):
    NS[name] = sympy.Symbol(name)
NS["e"] = sympy.E
NS["i"] = sympy.I
TRANSFORMS = standard_transformations + (convert_xor, implicit_multiplication_application)


def parse(s: str):
    return parse_expr(s, local_dict=dict(NS), transformations=TRANSFORMS, evaluate=True)


def fmt(v):
    out = {"result": str(v)}
    try:
        out["latex"] = sympy.latex(v)
    except Exception:
        pass
    try:
        if isinstance(v, sympy.Basic) and v.free_symbols == set() and not v.is_Integer:
            out["decimal"] = str(sympy.N(v, 12))
    except Exception:
        pass
    return out


def check_equal(a_s: str, b_s: str, variables):
    a, b = parse(a_s), parse(b_s)
    if isinstance(a, sympy.Equality) or isinstance(b, sympy.Equality):
        # compare equations by moving everything to one side (up to a constant factor)
        a = a.lhs - a.rhs if isinstance(a, sympy.Equality) else a
        b = b.lhs - b.rhs if isinstance(b, sympy.Equality) else b
    diff = sympy.simplify(a - b)
    if diff == 0:
        return {"equal": True, "method": "symbolic", "difference": "0"}
    syms = sorted((a - b).free_symbols, key=str)
    if variables:
        syms = [sympy.Symbol(v) for v in variables]
    # numeric spot checks at random points
    mismatches = 0
    tested = 0
    for _ in range(12):
        point = {s: sympy.Float(random.uniform(0.3, 2.7)) for s in syms}
        try:
            va = complex(sympy.N(a.subs(point)))
            vb = complex(sympy.N(b.subs(point)))
        except Exception:
            continue
        tested += 1
        if abs(va - vb) > 1e-8 * max(1.0, abs(va), abs(vb)):
            mismatches += 1
    if tested and mismatches == 0:
        return {"equal": True, "method": f"numeric ({tested} random points); symbolic simplification inconclusive", "difference": str(diff)}
    return {"equal": False, "method": "symbolic + numeric", "difference": str(diff), "mismatching_points": mismatches, "tested_points": tested}


def handle(req):
    op = req.get("op")
    if op == "evaluate":
        return fmt(parse(req["expression"]))
    if op == "check_equal":
        return check_equal(req["a"], req["b"], req.get("variables"))
    raise ValueError(f"unknown op {op}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            resp = {"id": req.get("id"), "ok": True, **handle(req)}
        except Exception as e:  # noqa: BLE001
            resp = {"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()
    main()
