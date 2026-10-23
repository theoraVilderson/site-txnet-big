# Python 2.4, which IBSng was written for, read a non-ASCII byte in source as
# latin-1 with a warning; 2.7 refuses the file. Declares what 2.4 assumed, on
# every file that has such a byte and no declaration of its own.
import os, re, sys

CODING = re.compile(r"coding[:=]")
for root, _, names in os.walk(sys.argv[1]):
    for name in names:
        if not name.endswith(".py"):
            continue
        path = os.path.join(root, name)
        lines = open(path).readlines()
        if any(CODING.search(l) for l in lines[:2]):
            continue
        if not any(ord(c) > 127 for l in lines for c in l):
            continue
        at = 1 if lines and lines[0].startswith("#!") else 0
        lines.insert(at, "# -*- coding: latin-1 -*-\n")
        open(path, "w").writelines(lines)
        print "declared latin-1: %s" % path
