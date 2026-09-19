# check_answers.py — an answer key, checked exactly. For kits/exam.ts.
#
# stdin:  [{"question": "3(a)", "kind": "...", "expr": "...", "var": "x", "claimed": "...", ...}]
# stdout: [{"question": "3(a)", "verdict": "ok" | "wrong" | "unverified", "detail": "..."}]
#
# kinds:  derivative          d/dvar expr                                   == claimed
#         antiderivative      d/dvar claimed                                == expr     (an indefinite integral, checked backwards)
#         definite_integral   integral of expr, var from `lower` to `upper` == claimed  ("diverges" is a claim too)
#         limit               limit of expr as var -> `point` (`dir`: "+", "-" or "")   == claimed  ("dne" is a claim too)
#         series_sum          sum of expr, var from `lower` to oo           == claimed
#         series_converges    sum of expr, var from `lower` to oo; claimed is "converges" or "diverges"
#         taylor              Taylor polynomial of expr about `point`, up to degree `order` == claimed
#         value               expr == claimed (any closed form: a slope, an area, a root)
#
# Expressions are written by a language model that has read web pages, and sympy's parser evaluates what
# it is given. So nothing is parsed until it is made of allowed characters and allowed names only.
import json
import re
import signal
import sys

import sympy as sp
from sympy.parsing.sympy_parser import convert_xor, implicit_multiplication_application, parse_expr, standard_transformations

NAMES = {name: getattr(sp, name) for name in (
    "sin cos tan sec csc cot asin acos atan sinh cosh tanh asinh acosh atanh exp log sqrt cbrt Abs factorial binomial "
    "pi E oo Rational Integer sign floor ceiling gamma erf").split()}
NAMES["ln"] = sp.log
NAMES["e"] = sp.E
NAMES["arcsin"], NAMES["arccos"], NAMES["arctan"] = sp.asin, sp.acos, sp.atan
VARIABLES = {name: sp.Symbol(name, real=True) for name in "x y t u s r a b c h".split()}
VARIABLES.update({name: sp.Symbol(name, integer=True, positive=True) for name in "n k m".split()})
ALLOWED = {**NAMES, **VARIABLES}
TRANSFORMS = standard_transformations + (convert_xor, implicit_multiplication_application)
SECONDS = 25


class Refused(Exception):
    pass


def parse(text):
    text = str(text).strip()
    if not text or len(text) > 400:
        raise Refused("empty or too long")
    if not re.fullmatch(r"[0-9A-Za-z_+\-*/^().,\s]+", text) or "__" in text:
        raise Refused("characters outside plain arithmetic")
    for name in re.findall(r"[A-Za-z_][A-Za-z_0-9]*", text):
        if name not in ALLOWED:
            raise Refused(f"unknown name: {name}")
    return parse_expr(text, local_dict=dict(ALLOWED), global_dict={"Integer": sp.Integer, "Float": sp.Float, "Rational": sp.Rational, "Symbol": sp.Symbol}, transformations=TRANSFORMS)


def same(a, b, symbols=()):
    """Equal as expressions; failing a proof, equal at several points."""
    diff = sp.simplify(a - b)
    if diff == 0:
        return True
    free = list((a - b).free_symbols)
    if not free:
        try:
            return abs(complex(sp.N(a - b, 30))) < 1e-9
        except (TypeError, ValueError):
            return False
    hits = 0
    for point in (sp.Rational(3, 7), sp.Rational(11, 5), sp.Rational(5, 2), sp.Rational(13, 3), sp.Rational(7, 9)):
        try:
            value = complex(sp.N((a - b).subs({s: point + i for i, s in enumerate(free)}), 30))
        except (TypeError, ValueError):
            continue
        if value != value:  # nan: outside the domain
            continue
        if abs(value) > 1e-8:
            return False
        hits += 1
    return hits >= 3


def check(item):
    kind = item.get("kind")
    var = VARIABLES.get(str(item.get("var", "x")))
    if var is None:
        raise Refused(f"unknown variable: {item.get('var')}")
    claimed_text = str(item.get("claimed", "")).strip().lower()
    expr = parse(item["expr"])

    if kind == "series_converges":
        verdict = sp.Sum(expr, (var, parse(item.get("lower", "1")), sp.oo)).is_convergent()
        found = "converges" if verdict == sp.true else "diverges" if verdict == sp.false else None
        if found is None:
            return "unverified", "sympy could not decide convergence"
        return ("ok", found) if found == claimed_text else ("wrong", f"sympy finds that it {found}")

    if kind == "definite_integral":
        value = sp.integrate(expr, (var, parse(item["lower"]), parse(item["upper"])))
        if claimed_text in ("diverges", "divergent"):
            return ("ok", "diverges") if value in (sp.oo, -sp.oo, sp.zoo) or value.has(sp.nan) else ("wrong", f"sympy gets {value}")
        if value.has(sp.Integral):
            value = sp.Integral(expr, (var, parse(item["lower"]), parse(item["upper"]))).evalf(25)
        return ("ok", str(value)) if same(value, parse(item["claimed"])) else ("wrong", f"sympy gets {sp.simplify(value)}")

    if kind == "limit":
        point, direction = parse(item["point"]), str(item.get("dir", "") or "")
        if direction in ("+", "-"):
            value = sp.limit(expr, var, point, direction)
        else:
            left, right = sp.limit(expr, var, point, "-"), sp.limit(expr, var, point, "+")
            if point in (sp.oo, -sp.oo):
                value = sp.limit(expr, var, point)
            elif left != right:
                return ("ok", "the one-sided limits differ") if claimed_text in ("dne", "does not exist") else ("wrong", f"the one-sided limits are {left} and {right}")
            else:
                value = left
        if claimed_text in ("dne", "does not exist"):
            return "wrong", f"sympy gets {value}"
        return ("ok", str(value)) if same(value, parse(item["claimed"])) else ("wrong", f"sympy gets {value}")

    claimed = parse(item["claimed"])
    if kind == "derivative":
        value = sp.diff(expr, var, int(item.get("order", 1)))
        return ("ok", "") if same(value, claimed) else ("wrong", f"sympy gets {sp.simplify(value)}")
    if kind == "antiderivative":
        back = sp.diff(claimed, var)
        return ("ok", "") if same(back, expr) else ("wrong", f"the derivative of the claimed antiderivative is {sp.simplify(back)}, not the integrand")
    if kind == "series_sum":
        value = sp.summation(expr, (var, parse(item.get("lower", "1")), sp.oo))
        if value.has(sp.Sum):
            return "unverified", "sympy has no closed form for this sum"
        return ("ok", str(value)) if same(value, claimed) else ("wrong", f"sympy gets {value}")
    if kind == "taylor":
        value = sp.series(expr, var, parse(item.get("point", "0")), int(item.get("order", 4)) + 1).removeO()
        return ("ok", "") if same(sp.expand(value), sp.expand(claimed)) else ("wrong", f"sympy gets {sp.expand(value)}")
    if kind == "value":
        return ("ok", "") if same(expr, claimed) else ("wrong", f"sympy gets {sp.simplify(expr)}")
    raise Refused(f"unknown kind: {kind}")


def timed_out(_signum, _frame):
    raise TimeoutError()


def main():
    try:
        items = json.loads(sys.stdin.read() or "[]")
    except json.JSONDecodeError as error:
        print(json.dumps([{"question": "?", "verdict": "unverified", "detail": f"the key is not JSON: {error}"}]))
        return
    results = []
    signal.signal(signal.SIGALRM, timed_out)
    for item in items if isinstance(items, list) else []:
        question = str(item.get("question", "?")) if isinstance(item, dict) else "?"
        try:
            signal.alarm(SECONDS)
            verdict, detail = check(item)
        except TimeoutError:
            verdict, detail = "unverified", f"sympy did not finish in {SECONDS} s"
        except Refused as error:
            verdict, detail = "unverified", f"not checked: {error}"
        except Exception as error:  # noqa: BLE001  one bad entry should not lose the rest
            verdict, detail = "unverified", f"could not be checked: {type(error).__name__}: {str(error)[:160]}"
        finally:
            signal.alarm(0)
        results.append({"question": question, "verdict": verdict, "detail": detail})
    print(json.dumps(results))


main()
