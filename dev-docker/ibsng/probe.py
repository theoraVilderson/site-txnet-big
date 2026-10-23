# Re-proves, on this IBSng A1.24, every wire shape and behaviour the ibsng
# driver relies on (network contract.ibsng.md, ADR-0160 decision 13).
# Python 2, inside the container: IBSng's XML-RPC on 127.0.0.1:1235 and
# radclient as the NAS, a `Mikrotik` RAS at 127.0.0.1 with SNMP off.
#   docker exec txnet-dev-ibsng python /usr/local/bin/probe.py
# Prints `ok:` or `FAIL:` per check and exits non-zero on any FAIL. Its users
# are named probe-<time> and deleted at the end, so it can run again.
import os, re, subprocess, sys, time, xmlrpclib

API = xmlrpclib.ServerProxy("http://127.0.0.1:1235/")
PASSWORD = os.environ.get("IBSNG_SYSTEM_PASSWORD", "txnet-dev-ibsng")
SECRET = "probe-secret"
CHARGE = "txnet"
# A period that never comes round (ADR-0160 decision 13): 100 years of days.
NEVER_DAYS = 36500
# IBSng re-checks an online user at most this often (CanStayOnlineResult).
RECHECK_SECONDS = 30
# The most rows one searchUser or report call returns (report_lib.checkFromTo).
PAGE = 3000
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
failed = []


def call(method, **args):
    args.update(auth_name="system", auth_pass=PASSWORD, auth_type="ADMIN")
    return getattr(API, method)(args)


def fault(method, **args):
    try:
        call(method, **args)
    except xmlrpclib.Fault, e:
        return e.faultString
    return None


def check(name, ok, detail=""):
    print "%s %s%s" % ("ok:  " if ok else "FAIL:", name, (" -- %s" % detail) if detail else "")
    if not ok:
        failed.append(name)


def radius(kind, **attrs):
    port = "1812" if kind == "auth" else "1813"
    body = "".join("%s=%s\n" % (k.replace("_", "-"), v) for k, v in attrs.items())
    p = subprocess.Popen(["radclient", "-x", "-r", "1", "-t", "3", "127.0.0.1:" + port, kind, SECRET],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return p.communicate(body + "NAS-IP-Address=127.0.0.1\n")[0]


def acct(user, status, port, inp=0, out=0):
    extra = {}
    if status == "Stop":
        # The Mikrotik RAS drops a Stop without it, as a MikroTik NAS never sends.
        extra["Acct_Terminate_Cause"] = "User-Request"
    return radius("acct", User_Name=user, Acct_Status_Type=status, Acct_Session_Id="%s-%s" % (user, port),
                  NAS_Port=port, Framed_IP_Address="10.9.0.%d" % (port % 250), Acct_Input_Octets=inp,
                  Acct_Output_Octets=out, **extra)


def interim_pause():
    """The Mikrotik RAS divides by the whole seconds since the last update, so
    two in one second raise and the second is dropped; a NAS waits minutes."""
    time.sleep(1.5)


def attrs(user_id):
    return call("user.getUserInfo", user_id=str(user_id))[str(user_id)]["attrs"]


def online(username):
    for row in call("report.getOnlineUsers", normal_sort_by="user_id", normal_desc=False,
                    voip_sort_by="user_id", voip_desc=False, conds={})[0]:
        if row["normal_username"] == username:
            return row
    return None


def fixtures():
    """The free charge, its group and the probe's RAS, made once."""
    if fault("charge.getChargeInfo", charge_name=CHARGE):
        call("charge.addNewCharge", name=CHARGE, comment="TXNet: prices nothing",
             charge_type="Internet", visible_to_all="t")
    if not call("charge.listChargeRules", charge_name=CHARGE):
        # A list argument goes as a dict keyed "0", "1", ...: IBSng's fixList
        # returns the key's own name for a real list (request.py).
        call("charge.addInternetChargeRule", charge_name=CHARGE, rule_start="00:00:00",
             rule_end="23:59:59", cpm=0, cpk=0, assumed_kps=125000, bandwidth_limit_kbytes=0,
             ras="_ALL_", ports="_ALL_", dows=dict((str(i), d) for i, d in enumerate(DAYS)),
             tx_leaf_name="", rx_leaf_name="")
    if fault("group.getGroupInfo", group_name=CHARGE):
        call("group.addNewGroup", group_name=CHARGE, comment="TXNet users")
        call("group.updateGroupAttrs", group_name=CHARGE, attrs={"normal_charge": CHARGE}, to_del_attrs={})
    if fault("ras.getRasInfo", ras_ip="127.0.0.1"):
        call("ras.addNewRas", ras_ip="127.0.0.1", ras_type="Mikrotik", radius_secret=SECRET,
             ras_description="probe", comment="")
        call("ras.updateAttributes", ras_ip="127.0.0.1", attrs={"mikrotik_snmp_enabled": "0"})


def new_user(name, limit):
    uid = call("user.addNewUsers", count=1, credit=1, owner_name="system", group_name=CHARGE,
               credit_comment="probe")[0]
    call("user.updateUserAttrs", user_id=str(uid), to_del_attrs={}, attrs={
        "normal_username": name, "normal_password": "pw-" + name, "normal_generate_password": 0,
        "normal_generate_password_len": 0, "normal_save_usernames": 0, "comment": "txnet:probe",
        "traffic_periodic_accounting_daily": NEVER_DAYS,
        "traffic_periodic_accounting_daily_limit": str(limit)})
    return uid


def main():
    stamp = int(time.time())
    a, b = "probe-%da" % stamp, "probe-%db" % stamp
    port = stamp % 10000

    # 1. A wrong admin password is a Fault whose string is CODE|text.
    try:
        API.user.searchUser({"auth_name": "system", "auth_pass": "wrong", "auth_type": "ADMIN",
                             "conds": {}, "from": 0, "to": 1, "order_by": "user_id", "desc": False})
        check("wrong password refused", False, "answered")
    except xmlrpclib.Fault, e:
        check("wrong password refused", e.faultString.startswith("INCORRECT_PASSWORD|"), e.faultString)

    fixtures()
    check("charge prices nothing", [(r["cpm"], r["cpk"]) for r in
                                    call("charge.listChargeRules", charge_name=CHARGE)] == [(0, 0)])

    limit = 5 * 1024 * 1024
    ua, ub = new_user(a, limit), new_user(b, 100 * 1024 * 1024)
    try:
        # 2. getUserInfo answers for several ids at once and returns the
        #    password in clear: the driver drops it (ADR-0160 decision 2).
        both = call("user.getUserInfo", user_id="%d,%d" % (ua, ub))
        check("getUserInfo is one call for many ids", sorted(both) == sorted([str(ua), str(ub)]))
        check("getUserInfo carries the password in clear",
              both[str(ua)]["attrs"].get("normal_password") == "pw-" + a)
        check("searchUser finds by normal_username",
              call("user.searchUser", conds={"normal_username": a, "normal_username_op": "equals"},
                   order_by="user_id", desc=False, **{"from": 0, "to": 10})[1] == [ua])

        # 3. Under the limit the login is accepted; the usage IBSng checks the
        #    limit against is upload plus download of the last update.
        out = radius("auth", User_Name=a, User_Password="pw-" + a, NAS_Port=port, NAS_Port_Type="Virtual")
        check("login under the limit accepted", "Access-Accept" in out)
        acct(a, "Start", port)
        # 4. The never-coming period is accepted: the first login sets its
        #    reset, ~100 years out.
        reset = attrs(ua).get("traffic_periodic_accounting_daily_reset", "")
        check("a 100-year period is accepted",
              reset[:4].isdigit() and int(reset[:4]) >= time.gmtime().tm_year + 99, reset)
        interim_pause()
        acct(a, "3", port, inp=1000000, out=2000000)
        row = online(a)
        check("an open session is in getOnlineUsers, in_bytes = Acct-Output-Octets",
              row is not None and row["in_bytes"] == 2000000 and row["out_bytes"] == 1000000)
        check("usage is read live, upload plus download",
              attrs(ua).get("traffic_periodic_accounting_daily_usage") == "3000000")

        # 5. Crossing the limit: IBSng decides the kill itself at its next
        #    re-check, and asks the NAS to end the session.
        interim_pause()
        acct(a, "3", port, inp=2000000, out=4000000)
        reason, deadline = None, time.time() + RECHECK_SECONDS + 15
        while time.time() < deadline and not reason:
            time.sleep(2)
            reason = (online(a) or {}).get("attrs", {}).get("kill_reason")
        check("crossing the limit is killed within its re-check",
              reason == "User Traffic quota has been exceeded", reason or "no kill")

        # 6. A Stop's own octets are not counted on a Mikrotik RAS with SNMP
        #    off: the usage stays at the last interim update.
        acct(a, "Stop", port, inp=2100000, out=4200000)
        check("a Stop's octets are not counted (Mikrotik RAS, SNMP off)",
              attrs(ua).get("traffic_periodic_accounting_daily_usage") == "6000000",
              attrs(ua).get("traffic_periodic_accounting_daily_usage"))

        # 7. Over the limit the next login is refused, E=915.
        out = radius("auth", User_Name=a, User_Password="pw-" + a, NAS_Port=port + 1, NAS_Port_Type="Virtual")
        check("login over the limit refused", "Access-Reject" in out and "E=915" in out,
              (re.findall(r"Reply-Message = .*", out) or [""])[0])

        # 8. A lock refuses a login; deleting it lets the user back.
        call("user.updateUserAttrs", user_id=str(ub), attrs={"lock": "txnet: disabled"}, to_del_attrs={})
        out = radius("auth", User_Name=b, User_Password="pw-" + b, NAS_Port=port + 2, NAS_Port_Type="Virtual")
        check("a locked user is refused", "Access-Reject" in out)
        call("user.updateUserAttrs", user_id=str(ub), attrs={}, to_del_attrs={"0": "lock"})
        out = radius("auth", User_Name=b, User_Password="pw-" + b, NAS_Port=port + 3, NAS_Port_Type="Virtual")
        check("an unlocked user logs in", "Access-Accept" in out)

        # 9. Closed sessions summed per user, the credit untouched.
        sums = dict((r[0], r[2] + r[3]) for r in call("report.getInOutUsages", conds={}, **{"from": 0, "to": PAGE})["report"])
        check("getInOutUsages sums closed sessions per user", sums.get(ua) == 6000000, sums.get(ua))
        over = fault("user.searchUser", conds={}, order_by="user_id", desc=False, **{"from": 0, "to": PAGE + 1})
        check("a page is at most 3000 rows", (over or "").startswith("TO_VALUE_INVALID|"), over)
        credit = call("user.getUserInfo", user_id=str(ua))[str(ua)]["basic_info"]["credit"]
        check("the credit is never spent", credit == 1, credit)
    finally:
        for p in (port, port + 1, port + 2, port + 3):
            acct(a, "Stop", p)
            acct(b, "Stop", p)
        call("user.delUser", user_id="%d,%d" % (ua, ub), delete_comment="probe",
             del_connection_logs=True, del_audit_logs=True)
        check("a deleted user is gone", (fault("user.getUserInfo", user_id=str(ua)) or "").startswith("USERID_DOESNT_EXISTS|"))

    print "%d failed" % len(failed)
    sys.exit(1 if failed else 0)


main()
