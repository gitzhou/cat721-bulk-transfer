# cat721-bulk-transfer

[![build](https://github.com/gitzhou/cat721-bulk-transfer/actions/workflows/build.yml/badge.svg)](https://github.com/gitzhou/cat721-bulk-transfer/actions/workflows/build.yml)
![NPM Version](https://img.shields.io/npm/v/cat721-bulk-transfer)

A tiny CLI tool to bulk transfer CAT-721 NFTs:

- Read transfer details from a CSV file.
- Transfer NFTs from different addresses to different addresses.
- A single WIF pays transaction fees.

## Installation

```
$ npm install -g cat721-bulk-transfer
```

## Usage

```
$ cat721-bulk-transfer -h
Usage: cat721-bulk-transfer [options]

Bulk transfer CAT-721 NFTs

Options:
  -v, --version                        output the version number
  -s, --source-file <source-file>      source file path
  -c, --collection-id <collection-id>  NFT collection ID
  -t, --tracker-host <tracker-host>    tracker host, e.g. http://127.0.0.1:3000
  -f, --fee-rate <fee-rate>            fee rate in sat/vB that is used for the transfer (default: 1)
  -w, --fee-wif <wif>                  WIF that provides transfer fees
  -h, --help                           display help for command
```

## Source file format

```
<NFT owner address>,<owner address WIF>,<NFT local id to send>,<NFT receiver address>
<NFT owner address>,<owner address WIF>,<NFT local id to send>,<NFT receiver address>
...
```
