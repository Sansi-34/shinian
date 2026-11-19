"""拾念 SHINIAN v0.1 - 仅手动闭环回归入口

设置 SHINIAN_TEST_MANUAL_ONLY=1 后运行 run_tests.py：
- 使用独立测试库 db/test.sqlite 与端口 3100
- 运行 test_api / test_search / test_consistency（不含后续迭代的 AI 套件）
- 重启服务后核对记录与引用仍在
"""
import os
import runpy
import sys

os.environ["SHINIAN_TEST_MANUAL_ONLY"] = "1"
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
runpy.run_path(os.path.join(HERE, "run_tests.py"), run_name="__main__")