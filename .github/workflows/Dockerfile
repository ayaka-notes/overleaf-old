# 使用方法：docker build -t ayaka-notes/overleaf:latest .
FROM sharelatex/sharelatex:latest

# 安装texlive  tlmgr install scheme-full
RUN tlmgr install scheme-full

# 添加路径
RUN tlmgr path add

