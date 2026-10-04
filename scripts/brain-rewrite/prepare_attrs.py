#!/usr/bin/env python3
"""Write the generated root .gitattributes blob into the repo being rewritten and
record its id for attrs.py (BRW_RUN/attrs-blob.txt).

  prepare_attrs.py --gitdir src.git --run RUN
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--gitdir", required=True)
ap.add_argument("--run", required=True)
a = ap.parse_args()
blob = B.hash_object_w(a.gitdir, B.gitattributes_text())
with open(os.path.join(a.run, "attrs-blob.txt"), "wb") as f:
    f.write(blob + b"\n")
with open(os.path.join(a.run, "gitattributes.generated"), "wb") as f:
    f.write(B.gitattributes_text())
print("attrs blob %s" % blob.decode())
