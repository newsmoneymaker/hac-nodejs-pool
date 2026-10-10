# x16rshash: Hacash's own X16RS hash (via the x16rs-sys crate's vendored C source, copied verbatim
# from the node's own ~/.cargo registry cache -- never hand-modified, never borrowed from another coin).
CXX ?= g++
CC ?= gcc

CFLAGS = -O2 -w -Ix16rs-src
CXXFLAGS = -O2 -std=c++14 -Ix16rs-src

x16rshash: x16rshash.o x16rs.o
	$(CXX) -O2 -o $@ x16rshash.o x16rs.o

x16rshash.o: x16rshash.cpp
	$(CXX) $(CXXFLAGS) -c -o $@ $<

x16rs.o: x16rs-src/x16rs.c
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f x16rshash x16rshash.o x16rs.o
