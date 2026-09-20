#!/usr/bin/env python3
"""Set, change or remove this instance's login password, without starting the server.

The server ships with no password: a local install opens straight into the app, no
login screen. A password is only needed when other people can reach the port — your
LAN, a tunnel, the internet (otherwise they can read, write and spend your API key).

    python3 set_password.py                  # show the current state
    python3 set_password.py 'my-password'    # set / change it (min 8 characters)
    python3 set_password.py --clear          # remove it → opens without logging in

Point it at another instance with REVISION_DATA_DIR, the same variable the server
reads — e.g. a second copy living in ~/mbbs-pku:

    REVISION_DATA_DIR=~/mbbs-pku python3 set_password.py --clear

The server caches config.json in memory, so restart it afterwards to apply. If it is
managed by launchd (setup-autostart.sh), that is:

    launchctl kickstart -k gui/$(id -u)/com.mbbs.revision

(Find your label with: launchctl list | grep -i mbbs)
"""
import base64
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("REVISION_DATA_DIR") or os.path.join(ROOT, "data")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as exc:
        print("读不了 %s: %s" % (CONFIG_PATH, exc), file=sys.stderr)
        return None


def save_config(cfg):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONFIG_PATH)


def show_state(cfg):
    print("数据目录: %s" % DATA_DIR)
    if os.environ.get("PASSWORD"):
        print("密码: 由环境变量 PASSWORD 提供（优先级最高，config.json 里的值不起作用）")
    elif cfg.get("password_hash"):
        print("密码: 已设置 —— 打开网址需要登录")
    else:
        print("密码: 未设置 —— 打开网址即可使用，没有登录页")


def apply(cfg, new_password):
    """Write the new state, rotating the session secret.

    Rotating invalidates every token handed out before, so devices that were already
    signed in have to authenticate again under the new state.
    """
    cfg["password_hash"] = sha256(new_password) if new_password else ""
    cfg["secret"] = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")
    save_config(cfg)
    print("已写入 %s" % CONFIG_PATH)


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        cfg = load_config()
        if cfg is None:
            return 1
        show_state(cfg)
        print("\n用法: python3 set_password.py '<新密码>'  |  python3 set_password.py --clear")
        return 0

    cfg = load_config()
    if cfg is None:
        return 1

    if args[0] in ("--clear", "--none", "clear"):
        if os.environ.get("PASSWORD"):
            print("注意: 环境变量 PASSWORD 还在，这个实例仍然需要密码。")
            print("      去掉启动脚本 / docker run 里的 PASSWORD 才会变成免密。")
        show_state(cfg)
        apply(cfg, "")
        print("完成: 打开网址不再需要密码（重启服务后生效）")
        return 0

    password = args[0]
    if len(password) < 8:
        print("密码至少 8 位。", file=sys.stderr)
        return 2
    show_state(cfg)
    apply(cfg, password)
    print("完成: 登录密码已更新（重启服务后生效；已登录的设备需要重新登录）")
    if os.environ.get("PASSWORD"):
        print("提示: 环境变量 PASSWORD 的优先级更高，会覆盖这里的值。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
