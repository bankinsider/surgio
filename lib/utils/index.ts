import assert from 'assert';
import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs-extra';
import _ from 'lodash';
import LRU from 'lru-cache';
import path from 'path';
import queryString from 'query-string';
import { JsonObject } from 'type-fest';
import URL from 'url';
import URLSafeBase64 from 'urlsafe-base64';
import YAML from 'yaml';
import os from 'os';

import {
  CommandConfig,
  HttpsNodeConfig,
  NodeFilterType,
  NodeNameFilterType,
  NodeTypeEnum,
  PlainObjectOf,
  PossibleNodeConfigType,
  ProxyGroupModifier,
  RemoteSnippet,
  RemoteSnippetConfig,
  ShadowsocksNodeConfig,
  ShadowsocksrNodeConfig,
  SimpleNodeConfig,
  SnellNodeConfig,
  VmessNodeConfig,
} from '../types';
import { normalizeConfig, validateConfig } from './config';
import { parseSSRUri } from './ssr';
import { OBFS_UA, NETWORK_TIMEOUT } from './constant';

export const ConfigCache = new LRU<string, any>({
  maxAge: 10 * 60 * 1000, // 1min
});

// istanbul ignore next
export const resolveRoot = (...args: readonly string[]): string =>
  path.join(__dirname, '../../', ...args);

export const getDownloadUrl = (baseUrl: string = '/', artifactName: string, inline: boolean = true, accessToken?: string): string => {
  const urlObject = URL.parse(`${baseUrl}${artifactName}`, true);

  if (accessToken) {
    urlObject.query.access_token = accessToken;
  }

  if (!inline) {
    urlObject.query.dl = '1';
  }

  return URL.format(urlObject);
};

export const getBlackSSLConfig = async (username: string, password: string): Promise<ReadonlyArray<HttpsNodeConfig>> => {
  assert(username, 'Lack of BlackSSL username.');
  assert(password, 'Lack of BlackSSL password.');

  const key = `blackssl_${username}`;

  async function requestConfigFromBlackSSL(): Promise<ReadonlyArray<HttpsNodeConfig>> {
    const response = await axios
      .get('https://api.darkssl.com/v1/service/ssl_info', {
        params: {
          username,
          password,
        },
        timeout: NETWORK_TIMEOUT,
        headers: {
          'User-Agent': 'GoAgentX/774 CFNetwork/901.1 Darwin/17.6.0 (x86_64)',
        },
      });

    const result = (response.data.ssl_nodes as readonly any[]).map<HttpsNodeConfig>(item => ({
      nodeName: item.name,
      type: NodeTypeEnum.HTTPS,
      hostname: item.server,
      port: item.port,
      username,
      password,
    }));

    ConfigCache.set(key, result);

    return result;
  }

  return ConfigCache.has(key) ?
    ConfigCache.get(key) :
    await requestConfigFromBlackSSL();
};

export const getShadowsocksJSONConfig = async (url: string, udpRelay: boolean): Promise<ReadonlyArray<ShadowsocksNodeConfig>> => {
  assert(url, '未指定订阅地址 url');

  async function requestConfigFromRemote(): Promise<ReadonlyArray<ShadowsocksNodeConfig>> {
    const response = await axios.get(url, {
      timeout: NETWORK_TIMEOUT,
    });

    const result = (response.data.configs as readonly any[]).map<ShadowsocksNodeConfig>(item => {
      const nodeConfig: any = {
        nodeName: item.remarks as string,
        type: NodeTypeEnum.Shadowsocks,
        hostname: item.server as string,
        port: item.server_port as string,
        method: item.method as string,
        password: item.password as string,
      };

      if (typeof udpRelay === 'boolean') {
        nodeConfig['udp-relay'] = udpRelay;
      }
      if (item.plugin === 'obfs-local') {
        const obfs = item.plugin_opts.match(/obfs=(\w+)/);
        const obfsHost = item.plugin_opts.match(/obfs-host=(.+)$/);

        if (obfs) {
          nodeConfig.obfs = obfs[1];
          nodeConfig['obfs-host'] = obfsHost ? obfsHost[1] : 'www.bing.com';
        }
      }

      return nodeConfig;
    });

    ConfigCache.set(url, result);

    return result;
  }

  return ConfigCache.has(url) ?
    ConfigCache.get(url) :
    await requestConfigFromRemote();
};

export const getShadowsocksSubscription = async (url: string, udpRelay?: boolean): Promise<ReadonlyArray<ShadowsocksNodeConfig>> => {
  assert(url, '未指定订阅地址 url');

  async function requestConfigFromRemote(): Promise<ReadonlyArray<ShadowsocksNodeConfig>> {
    const response = await axios.get(url, {
      timeout: NETWORK_TIMEOUT,
      responseType: 'text',
    });

    const configList = fromBase64(response.data).split('\n')
        .filter(item => !!item)
        .filter(item => item.startsWith("ss://"));
    const result = configList.map<any>(item => {
      const scheme = URL.parse(item, true);
      const userInfo = fromUrlSafeBase64(scheme.auth).split(':');
      const pluginInfo = typeof scheme.query.plugin === 'string' ? decodeStringList<any>(scheme.query.plugin.split(';')) : {};

      return {
        type: NodeTypeEnum.Shadowsocks,
        nodeName: decodeURIComponent(scheme.hash.replace('#', '')),
        hostname: scheme.hostname,
        port: scheme.port,
        method: userInfo[0],
        password: userInfo[1],
        ...(typeof udpRelay === 'boolean' ? {
          'udp-relay': udpRelay,
        } : null),
        ...(pluginInfo['obfs-local'] ? {
          obfs: pluginInfo.obfs,
          'obfs-host': pluginInfo['obfs-host'],
        } : null),
      };
    });

    ConfigCache.set(url, result);

    return result;
  }

  return ConfigCache.has(url) ?
    ConfigCache.get(url) :
    await requestConfigFromRemote();
};

export const getShadowsocksrSubscription = async (url: string): Promise<ReadonlyArray<ShadowsocksrNodeConfig>> => {
  assert(url, '未指定订阅地址 url');

  async function requestConfigFromRemote(): Promise<ReadonlyArray<ShadowsocksrNodeConfig>> {
    const response = await axios.get(url, {
      timeout: NETWORK_TIMEOUT,
      responseType: 'text',
    });

    const configList = fromBase64(response.data)
      .split('\n')
      .filter(item => !!item && item.startsWith("ssr://"));
    const result = configList.map<ShadowsocksrNodeConfig>(parseSSRUri);

    ConfigCache.set(url, result);

    return result;
  }

  return ConfigCache.has(url) ?
    ConfigCache.get(url) :
    await requestConfigFromRemote();
};

export const getV2rayNSubscription = async (url: string): Promise<ReadonlyArray<VmessNodeConfig>> => {
  assert(url, '未指定订阅地址 url');

  async function requestConfigFromRemote(): Promise<ReadonlyArray<VmessNodeConfig>> {
    const response = await axios.get(url, {
      timeout: NETWORK_TIMEOUT,
      responseType: 'text',
    });

    const configList = fromBase64(response.data).split('\n')
        .filter(item => !!item)
        .filter(item => item.startsWith("vmess://"));
    const result = configList.map<VmessNodeConfig>(item => {
      const json = JSON.parse(fromBase64(item.replace('vmess://', '')));

      if (!json.v || Number(json.v) !== 2) {
        throw new Error(`该订阅 ${url} 可能不是一个有效的 V2rayN 订阅。请参考 http://bit.ly/2N4lZ8X 进行排查`);
      }

      return {
        nodeName: json.ps,
        type: NodeTypeEnum.Vmess,
        hostname: json.add,
        port: json.port,
        method: 'auto',
        uuid: json.id,
        alterId: json.aid || '0',
        network: json.net,
        tls: json.tls === 'tls',
        host: json.host || '',
        path: json.path || '/',
      };
    });

    ConfigCache.set(url, result);

    return result;
  }

  return ConfigCache.has(url) ?
    ConfigCache.get(url) :
    await requestConfigFromRemote();
};

export const getSurgeNodes = (
  list: ReadonlyArray<HttpsNodeConfig|ShadowsocksNodeConfig|SnellNodeConfig|ShadowsocksrNodeConfig|VmessNodeConfig>,
  filter?: NodeFilterType,
): string => {
  const result: string[] = list
    .filter(item => filter ? filter(item) : true)
    .map<string>(nodeConfig => {
      if (nodeConfig.enable === false) { return null; }

      switch (nodeConfig.type) {
        case NodeTypeEnum.Shadowsocks: {
          const config = nodeConfig as ShadowsocksNodeConfig;

          return ([
            config.nodeName,
            [
              'custom',
              config.hostname,
              config.port,
              config.method,
              config.password,
              'https://raw.githubusercontent.com/ConnersHua/SSEncrypt/master/SSEncrypt.module',
              ...pickAndFormatStringList(config, ['udp-relay', 'obfs', 'obfs-host']),
            ].join(', ')
          ].join(' = '));
        }

        case NodeTypeEnum.HTTPS: {
          const config = nodeConfig as HttpsNodeConfig;

          return ([
            config.nodeName,
            [
              'https',
              config.hostname,
              config.port,
              config.username,
              config.password,
            ].join(', ')
          ].join(' = '));
        }

        case NodeTypeEnum.Snell: {
          const config = nodeConfig as SnellNodeConfig;

          return ([
            config.nodeName,
            [
              'snell',
              config.hostname,
              config.port,
              ...pickAndFormatStringList(config, ['psk', 'obfs']),
            ].join(', '),
          ].join(' = '));
        }

        case NodeTypeEnum.Shadowsocksr: {
          const config = nodeConfig as ShadowsocksrNodeConfig;

          // istanbul ignore next
          if (!config.binPath) {
            throw new Error('You must specify a binary file path for Shadowsocksr.');
          }

          const args = [
            '-s', config.hostname,
            '-p', `${config.port}`,
            '-m', config.method,
            '-o', config.obfs,
            '-O', config.protocol,
            '-k', config.password,
            '-l', `${config.localPort}`,
            '-b', '127.0.0.1',
          ];

          if (config.protoparam) {
            args.push('-G', config.protoparam);
          }
          if (config.obfsparam) {
            args.push('-g', config.obfsparam);
          }

          const configString = [
            'external',
            `exec = ${JSON.stringify(config.binPath)}`,
            ...(args).map(arg => `args = ${JSON.stringify(arg)}`),
            `local-port = ${config.localPort}`,
            `addresses = ${config.hostname}`,
          ].join(', ');

          return ([
            config.nodeName,
            configString,
          ].join(' = '));
        }

        case NodeTypeEnum.Vmess: {
          const config = nodeConfig as VmessNodeConfig;

          if (
            nodeConfig.surgeConfig &&
            nodeConfig.surgeConfig.v2ray === 'native'
          ) {
            // Native support for vmess

            const configList = [
              'vmess',
              config.hostname,
              config.port,
              `username=${config.uuid}`,
            ];

            function getHeader(
              host,
              ua = OBFS_UA
            ): string {
              return [
                `Host:${host}`,
                `User-Agent:${JSON.stringify(ua)}`,
              ].join('|');
            }

            if (config.network === 'ws') {
              configList.push('ws=true');
              configList.push(`ws-path=${config.path}`);
              configList.push(
                'ws-headers=' +
                getHeader(config.host || config.hostname)
              );
            }

            if (config.tls) {
              configList.push('tls=true');
            }

            return ([
              config.nodeName,
              configList.join(', '),
            ].join(' = '));
          } else {
            // Using external provider

            // istanbul ignore next
            if (!config.binPath) {
              throw new Error('You must specify a binary file path for V2Ray.');
            }

            const jsonFileName = `v2ray_${config.localPort}_${config.hostname}_${config.port}.json`;
            const jsonFilePath = path.join(ensureConfigFolder(), jsonFileName);
            const jsonFile = formatV2rayConfig(config.localPort, nodeConfig);
            const args = [
              '--config', jsonFilePath.replace(os.homedir(), '$HOME'),
            ];
            const configString = [
              'external',
              `exec = ${JSON.stringify(config.binPath)}`,
              ...(args).map(arg => `args = ${JSON.stringify(arg)}`),
              `local-port = ${config.localPort}`,
              `addresses = ${config.hostname}`,
            ].join(', ');

            if (process.env.NODE_ENV !== 'test') {
              fs.writeJSONSync(jsonFilePath, jsonFile);
            }

            return ([
              config.nodeName,
              configString,
            ].join(' = '));
          }
        }

        // istanbul ignore next
        default:
          console.log();
          console.log(chalk.yellow(`不支持为 Surge 生成 ${nodeConfig!.type} 的节点，节点 ${nodeConfig!.nodeName} 会被省略`));
          return null;
      }
    })
    .filter(item => item !== null);

  return result.join('\n');
};

export const getClashNodes = (
  list: ReadonlyArray<PossibleNodeConfigType>,
  filter?: NodeFilterType
): ReadonlyArray<any> => {
  return list
    .filter(item => filter ? filter(item) : true)
    .map(nodeConfig => {
      if (nodeConfig.enable === false) { return null; }

      switch (nodeConfig.type) {
        case NodeTypeEnum.Shadowsocks:
          return {
            type: 'ss',
            cipher: nodeConfig.method,
            name: nodeConfig.nodeName,
            password: nodeConfig.password,
            port: nodeConfig.port,
            server: nodeConfig.hostname,
            udp: nodeConfig['udp-relay'] || false,
            ...(nodeConfig.obfs ? {
              plugin: 'obfs',
              'plugin-opts': {
                mode: nodeConfig.obfs,
                host: nodeConfig['obfs-host'],
              },
            } : null),
          };

        case NodeTypeEnum.Vmess:
          return {
            type: 'vmess',
            cipher: nodeConfig.method,
            name: nodeConfig.nodeName,
            server: nodeConfig.hostname,
            port: nodeConfig.port,
            uuid: nodeConfig.uuid,
            alterId: nodeConfig.alterId,
            ...(nodeConfig.network === 'tcp' ? null : {
              network: nodeConfig.network,
            }),
            tls: nodeConfig.tls,
            ...(nodeConfig.network === 'ws' ? {
              'ws-path': nodeConfig.path,
              'ws-headers': {
                ...(nodeConfig.host ? { Host: nodeConfig.host } : null),
              },
            } : null),
          };

        case NodeTypeEnum.Shadowsocksr:
          return {
            type: 'ssr',
            name: nodeConfig.nodeName,
            server: nodeConfig.hostname,
            port: nodeConfig.port,
            password: nodeConfig.password,
            obfs: nodeConfig.obfs,
            obfsparam: nodeConfig.obfsparam,
            protocol: nodeConfig.protocol,
            protocolparam: nodeConfig.protoparam,
            cipher: nodeConfig.method,
          };

        // istanbul ignore next
        default:
          console.log();
          console.log(chalk.yellow(`不支持为 Clash 生成 ${nodeConfig.type} 的节点，节点 ${nodeConfig.nodeName} 会被省略`));
          return null;
      }
    })
    .filter(item => item !== null);
};

// istanbul ignore next
export const toUrlSafeBase64 = (str: string): string => URLSafeBase64.encode(Buffer.from(str, 'utf8'));

// istanbul ignore next
export const fromUrlSafeBase64 = (str: string): string => {
  if (URLSafeBase64.validate(str)) {
    return URLSafeBase64.decode(str).toString();
  }
  return fromBase64(str);
};

// istanbul ignore next
export const toBase64 = (str: string): string => Buffer.from(str, 'utf8').toString('base64');

// istanbul ignore next
export const fromBase64 = (str: string): string => Buffer.from(str, 'base64').toString('utf8');

/**
 * @see https://github.com/shadowsocks/shadowsocks-org/wiki/SIP002-URI-Scheme
 */
export const getShadowsocksNodes = (
  list: ReadonlyArray<ShadowsocksNodeConfig>,
  groupName: string = 'Surgio'
): string => {
  const result: ReadonlyArray<any> = list
    .map(nodeConfig => {
      if (nodeConfig.enable === false) { return null; }

      switch (nodeConfig.type) {
        case NodeTypeEnum.Shadowsocks: {
          const config = _.cloneDeep(nodeConfig);
          const query: {
            readonly plugin?: string;
            readonly group?: string;
          } = {
            ...(config.obfs ? {
              plugin: `${encodeURIComponent(`obfs-local;obfs=${config.obfs};obfs-host=${config['obfs-host']}`)}`,
            } : null),
            ...(groupName ? { group: encodeURIComponent(groupName) } : null),
          };

          return [
            'ss://',
            toUrlSafeBase64(`${config.method}:${config.password}`),
            '@',
            config.hostname,
            ':',
            config.port,
            '/?',
            queryString.stringify(query, {
              encode: false,
              sort: false,
            }),
            '#',
            encodeURIComponent(config.nodeName),
          ].join('');
        }

        // istanbul ignore next
        default:
          console.log();
          console.log(chalk.yellow(`在生成 Shadowsocks 节点时出现了 ${nodeConfig.type} 节点，节点 ${nodeConfig.nodeName} 会被省略`));
          return null;
      }
    })
    .filter(item => item !== null);

  return result.join('\n');
};

export const getShadowsocksrNodes = (list: ReadonlyArray<ShadowsocksrNodeConfig>, groupName: string): string => {
  const result: ReadonlyArray<string> = list
    .map(nodeConfig => {
      if (nodeConfig.enable === false) { return null; }

      switch (nodeConfig.type) {
        case NodeTypeEnum.Shadowsocksr: {
          const baseUri = [
            nodeConfig.hostname,
            nodeConfig.port,
            nodeConfig.protocol,
            nodeConfig.method,
            nodeConfig.obfs,
            toUrlSafeBase64(nodeConfig.password),
          ].join(':');
          const query = {
            obfsparam: toUrlSafeBase64(nodeConfig.obfsparam),
            protoparam: toUrlSafeBase64(nodeConfig.protoparam),
            remarks: toUrlSafeBase64(nodeConfig.nodeName),
            group: toUrlSafeBase64(groupName),
            udpport: 0,
            uot: 0,
          };

          return 'ssr://' + toUrlSafeBase64([
            baseUri,
            '/?',
            queryString.stringify(query, {
              encode: false,
            }),
          ].join(''));
        }

        // istanbul ignore next
        default:
          console.log();
          console.log(chalk.yellow(`在生成 Shadowsocksr 节点时出现了 ${nodeConfig.type} 节点，节点 ${nodeConfig.nodeName} 会被省略`));
          return null;
      }
    })
    .filter(item => item !== null);

  return result.join('\n');
};

export const getV2rayNNodes = (list: ReadonlyArray<VmessNodeConfig>): string => {
  const result: ReadonlyArray<string> = list
    .map<string>(nodeConfig => {
      if (nodeConfig.enable === false) { return null; }

      switch (nodeConfig.type) {
        case NodeTypeEnum.Vmess: {
          const json = {
            v: '2',
            ps: nodeConfig.nodeName,
            add: nodeConfig.hostname,
            port: `${nodeConfig.port}`,
            id: nodeConfig.uuid,
            aid: nodeConfig.alterId,
            net: nodeConfig.network,
            type: 'none',
            host: nodeConfig.host,
            path: nodeConfig.path,
            tls: nodeConfig.tls ? 'tls' : '',
          };

          return 'vmess://' + toBase64(JSON.stringify(json));
        }

        // istanbul ignore next
        default:
          console.log();
          console.log(chalk.yellow(`在生成 V2Ray 节点时出现了 ${nodeConfig.type} 节点，节点 ${nodeConfig.nodeName} 会被省略`));
          return null;
      }
    })
    .filter(item => !!item);

  return result.join('\n');
};

export const getQuantumultNodes = (
  list: ReadonlyArray<ShadowsocksNodeConfig|VmessNodeConfig|ShadowsocksrNodeConfig|HttpsNodeConfig>,
  groupName: string = 'Surgio',
  filter?: NodeNameFilterType,
): string => {
  function getHeader(
    host,
    ua = OBFS_UA
  ): string {
    return [
      `Host:${host}`,
      `User-Agent:${ua}`,
    ].join('[Rr][Nn]');
  }

  const result: ReadonlyArray<string> = list
    .filter(item => {
      if (filter) {
        return filter(item) && item.enable !== false;
      }
      return item.enable !== false;
    })
    .map<string>(nodeConfig => {
      switch (nodeConfig.type) {
        case NodeTypeEnum.Vmess: {
          const config = [
            'vmess', nodeConfig.hostname, nodeConfig.port,
            (nodeConfig.method === 'auto' ? 'chacha20-ietf-poly1305' : nodeConfig.method),
            JSON.stringify(nodeConfig.uuid), nodeConfig.alterId,
            `group=${groupName}`,
            `over-tls=${nodeConfig.tls === true ? 'true' : 'false'}`,
            `certificate=1`,
            `obfs=${nodeConfig.network}`,
            `obfs-path=${JSON.stringify(nodeConfig.path || '/')}`,
            `obfs-header=${JSON.stringify(getHeader(nodeConfig.host || nodeConfig.hostname ))}`,
          ].filter(value => !!value).join(',');

          return 'vmess://' + toBase64([
            nodeConfig.nodeName,
            config,
          ].join(' = '));
        }

        case NodeTypeEnum.Shadowsocks: {
          return getShadowsocksNodes([nodeConfig], groupName);
        }

        case NodeTypeEnum.Shadowsocksr:
          return getShadowsocksrNodes([nodeConfig], groupName);

        case NodeTypeEnum.HTTPS: {
          const config = [
            nodeConfig.nodeName,
            [
              'http',
              `upstream-proxy-address=${nodeConfig.hostname}`,
              `upstream-proxy-port=${nodeConfig.port}`,
              'upstream-proxy-auth=true',
              `upstream-proxy-username=${nodeConfig.username}`,
              `upstream-proxy-password=${nodeConfig.password}`,
              'over-tls=true',
              'certificate=1'
            ].join(', ')
          ].join(' = ');

          return 'http://' + toBase64(config);
        }

        // istanbul ignore next
        default:
          console.log();
          console.log(chalk.yellow(`不支持为 Quantumult 生成 ${nodeConfig!.type} 的节点，节点 ${nodeConfig!.nodeName} 会被省略`));
          return null;
      }
    })
    .filter(item => !!item);

  return result.join('\n');
};

export const getShadowsocksNodesJSON = (list: ReadonlyArray<ShadowsocksNodeConfig>): string => {
  const nodes: ReadonlyArray<object> = list
    .map(nodeConfig => {
      if (nodeConfig.enable === false) { return null; }

      switch (nodeConfig.type) {
        case NodeTypeEnum.Shadowsocks: {
          const useObfs: boolean = Boolean(nodeConfig.obfs && nodeConfig['obfs-host']);
          return {
            remarks: nodeConfig.nodeName,
            server: nodeConfig.hostname,
            server_port: nodeConfig.port,
            method: nodeConfig.method,
            remarks_base64: toUrlSafeBase64(nodeConfig.nodeName),
            password: nodeConfig.password,
            tcp_over_udp: false,
            udp_over_tcp: false,
            enable: true,
            ...(useObfs ? {
              plugin: 'obfs-local',
              'plugin-opts': `obfs=${nodeConfig.obfs};obfs-host=${nodeConfig['obfs-host']}`
            } : null)
          };
        }

        // istanbul ignore next
        default:
          console.log();
          console.log(chalk.yellow(`在生成 Shadowsocks 节点时出现了 ${nodeConfig.type} 节点，节点 ${nodeConfig.nodeName} 会被省略`));
          return null;
      }
    })
    .filter(item => item !== null);

  return JSON.stringify(nodes, null, 2);
};

export const getNodeNames = (
  list: ReadonlyArray<SimpleNodeConfig>,
  filter?: NodeNameFilterType
): string => {
  const nodes = list.filter(item => {
    const result = item.enable !== false;

    if (filter) {
      return filter(item) && result;
    }

    return result;
  });

  return nodes.map(item => item.nodeName).join(', ');
};

export const getClashNodeNames = (
  ruleName: string,
  ruleType: 'select' | 'url-test',
  nodeNameList: ReadonlyArray<SimpleNodeConfig>,
  filter?: NodeNameFilterType,
  existingProxies?: ReadonlyArray<string>
): {
  readonly type: string;
  readonly name: string;
  readonly proxies: readonly string[];
  readonly url?: string;
  readonly interval?: number;
} => {
  const nodes = nodeNameList.filter(item => {
    const result = item.enable !== false;

    if (filter) {
      return filter(item) && result;
    }

    return result;
  });
  const proxies = existingProxies ?
    [].concat(existingProxies, nodes.map(item => item.nodeName)) :
    nodes.map(item => item.nodeName);

  return {
    type: ruleType,
    name: ruleName,
    proxies,
    ...(ruleType === 'url-test' ? {
      url: 'http://www.qualcomm.cn/generate_204',
      interval: 1200,
    } : null),
  };
};

export const toYaml = (obj: JsonObject): string => YAML.stringify(obj);

export const pickAndFormatStringList = (obj: object, keyList: readonly string[]): readonly string[] => {
  const result: string[] = [];
  keyList.forEach(key => {
    if (obj.hasOwnProperty(key)) {
      result.push(`${key}=${obj[key]}`);
    }
  });
  return result;
};

export const decodeStringList = <T = object>(stringList: ReadonlyArray<string>): T => {
  const result = {};
  stringList.forEach(item => {
    const pair = item.split('=');
    result[pair[0]] = pair[1] || true;
  });
  return result as T;
};

export const normalizeClashProxyGroupConfig = (
  nodeList: ReadonlyArray<PossibleNodeConfigType>,
  customFilters: PlainObjectOf<NodeNameFilterType>,
  proxyGroupModifier: ProxyGroupModifier
): ReadonlyArray<any> => {
  const proxyGroup = proxyGroupModifier(nodeList, customFilters);

  return proxyGroup.map<any>(item => {
    if (item.filter) {
      return getClashNodeNames(item.name, item.type, nodeList, item.filter, item.proxies);
    } else if (item.proxies) {
      return item;
    } else {
      return getClashNodeNames(item.name, item.type, nodeList);
    }
  });
};

export const addProxyToSurgeRuleSet = (str: string, rule: string): string => {
  const result: string[] = [];

  str
    .split('\n')
    .filter(item => item && item.trim() !== '')
    .forEach(item => {
      if (!item.startsWith('#') && !item.startsWith('//')) {
        const comment = item.split('//');
        const line = comment[0].trim().split(',');

        if (line.length === 2) {
          line.push(rule);
        } else {
          line.splice(2, 0, rule);
        }

        result.push(line.join(',') + (comment[1] ? ` //${comment[1]}` : ''));
      } else {
        result.push(item);
      }
    });

  return result.join('\n');
};

export const loadRemoteSnippetList = (remoteSnippetList: ReadonlyArray<RemoteSnippetConfig>): Promise<ReadonlyArray<RemoteSnippet>> => {
  function load(url: string): Promise<string> {
    console.log(`正在下载远程片段: ${url}`);

    return axios.get<string>(url, {
      timeout: NETWORK_TIMEOUT,
      responseType: 'text',
    })
      .then(data => {
        console.log(`远程片段下载成功: ${url}`);
        return data.data;
      })
      .catch(err => {
        console.error(`远程片段下载失败: ${url}`);
        throw err;
      });
  }

  return Promise.all(remoteSnippetList.map<Promise<RemoteSnippet>>(item => {
    const res = ConfigCache.has(item.url)
      ? Promise.resolve(ConfigCache.get(item.url)) :
      load(item.url)
        .then(str => {
          ConfigCache.set(item.url, str);
          return str;
        });

    return res.then(str => ({
      main: (rule: string) => addProxyToSurgeRuleSet(str, rule),
      name: item.name,
      url: item.url,
      text: str, // 原始内容
    }));
  }));
};

export const ensureConfigFolder = (dir: string = os.homedir()): string => {
  let baseDir;

  try {
    fs.accessSync(dir, fs.constants.W_OK);
    baseDir = dir;
  } catch (err) {
    // can't write
    baseDir = '/tmp';
  }

  const configDir = path.join(baseDir, '.config/surgio');
  fs.mkdirpSync(configDir);
  return configDir;
};

export const formatV2rayConfig = (localPort: string|number, nodeConfig: VmessNodeConfig): JsonObject => {
  const config: any = {
    log: {
      loglevel: 'warning'
    },
    inbound: {
      port: localPort,
      listen: '127.0.0.1',
      protocol: 'socks',
      settings: {
        auth: 'noauth',
      }
    },
    outbound: {
      protocol: 'vmess',
      settings: {
        vnext: [
          {
            address: nodeConfig.hostname,
            port: nodeConfig.port,
            users: [
              {
                id: nodeConfig.uuid,
                alterId: Number(nodeConfig.alterId),
                security: nodeConfig.method,
                level: 0,
              }
            ]
          }
        ]
      },
      streamSettings: {
        security: 'none',
      },
    }
  };

  if (nodeConfig.tls) {
    config.outbound.streamSettings = {
      ...config.outbound.streamSettings,
      security: 'tls',
      tlsSettings: {
        serverName: nodeConfig.host || nodeConfig.hostname,
      },
    };
  }

  if (nodeConfig.network === 'ws') {
    config.outbound.streamSettings = {
      ...config.outbound.streamSettings,
      network: nodeConfig.network,
      wsSettings: {
        path: nodeConfig.path,
        headers: {
          Host: nodeConfig.host,
          'User-Agent': OBFS_UA,
        },
      },
    };
  }

  return config;
};
