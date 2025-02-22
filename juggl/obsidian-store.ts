import {
  Component,
  getLinkpath,
  iterateCacheRefs,
  MetadataCache, ReferenceCache,
  TFile,
  Vault,
} from 'obsidian';
import type {ICoreDataStore, IMergedToGraph, IJuggl} from 'juggl-api';
import {DataStoreEvents} from './events';
import type JugglPlugin from './main';
import type {
  NodeDefinition,
  EdgeDefinition,
  NodeCollection,
} from 'cytoscape';
import {CLASS_EXPANDED} from './constants';
import {nodeDangling, nodeFromFile, parseRefCache, VizId} from 'juggl-api';

export const OBSIDIAN_STORE_NAME = 'Obsidian';

export class ObsidianStore extends Component implements ICoreDataStore {
    plugin: JugglPlugin;
    events: DataStoreEvents;
    metadata: MetadataCache;
    vault: Vault
    constructor(plugin: JugglPlugin) {
      super();
      this.plugin = plugin;
      this.events = new DataStoreEvents();
      this.metadata = plugin.app.metadataCache;
      this.vault = plugin.app.vault;
    }

    getEvents(): DataStoreEvents {
      return this.events;
    }

    async createEdges(srcFile: TFile, srcId: string, toNodes: NodeCollection, graph: IJuggl): Promise<EdgeDefinition[]> {
      if (!(srcFile.extension === 'md')) {
        return [];
      }
      const cache = this.metadata.getFileCache(srcFile);
      if (!cache) {
        return [];
      }

      const edges: Record<string, EdgeDefinition[]> = {};
      const content = (await this.vault.cachedRead(srcFile)).split('\n');
      iterateCacheRefs(cache, (ref) => {
        const otherId = this.getOtherId(ref, srcFile.path).toId();
        if (toNodes.$id(otherId).length > 0) {
          const edgeId = `${srcId}->${otherId}`;
          const count = edgeId in edges ? edges[edgeId].length + 1 : 1;
          const edge = parseRefCache(ref, content, `${edgeId}${count}`, srcId, otherId, this.plugin.settings.typedLinkPrefix);
          if (edgeId in edges) {
            edges[edgeId].push(edge);
          } else {
            edges[edgeId] = [edge];
          }
        }
      });
      if (graph.settings.mergeEdges) {
        // Merges inline edges.
        const returnEdges: EdgeDefinition[] = [];
        for (const edgeId of Object.keys(edges)) {
          const connectedEdges: EdgeDefinition[] = edges[edgeId];
          let inlineEdge: EdgeDefinition = null;
          let countInline = 0;
          for (const edge of connectedEdges) {
            if (edge.classes === ' inline') {
              if (inlineEdge) {
                inlineEdge.data.context += `
                
---

${edge.data.context}`;
                countInline += 1;
              } else {
                inlineEdge = edge;
                countInline = 1;
              }
            } else {
              returnEdges.push(edge);
            }
          }
          if (inlineEdge) {
            inlineEdge.data.edgeCount = countInline;
            returnEdges.push(inlineEdge);
          }
        }
        return returnEdges;
      }
      return [].concat(...Object.values(edges));
    }

    async connectNodes(allNodes: NodeCollection, newNodes: NodeCollection, graph: IJuggl): Promise<EdgeDefinition[]> {
      const edges: EdgeDefinition[] = [];
      // Find edges from newNodes to other nodes
      // @ts-ignore
      for (const node of newNodes) {
        const id = VizId.fromNode(node);
        if (id.storeId === this.storeId()) {
          const file = this.getFile(id);
          if (file) {
            const srcId = id.toId();

            edges.push(...await this.createEdges(file, srcId, allNodes, graph));
          }
        }
      }
      // @ts-ignore
      for (const node of allNodes.difference(newNodes)) {
        // For all nodes other than the new nodes
        const id = VizId.fromNode(node);
        if (id.storeId === this.storeId()) {
          const file = this.getFile(id);
          if (file) {
            const srcId = id.toId();

            // Connect only to newNodes!
            edges.push(...await this.createEdges(file, srcId, newNodes, graph));
          }
        }
      }
      return edges;
    }

    getOtherId(link: ReferenceCache, sourcePath: string) : VizId {
      const path = getLinkpath(link.link);
      const file = this.metadata.getFirstLinkpathDest(path, sourcePath);
      if (file) {
        return new VizId(file.name, this.storeId());
      } else {
        return new VizId(path, this.storeId() );
      }
    }

    async getNodeFromLink(link: ReferenceCache, sourcePath: string) : Promise<NodeDefinition> {
      const path = getLinkpath(link.link);
      const file = this.metadata.getFirstLinkpathDest(path, sourcePath);
      if (file) {
        return await nodeFromFile(file, this.plugin);
      } else {
        return nodeDangling(path);
      }
    }

    getFile(nodeId: VizId): TFile {
      return this.metadata.getFirstLinkpathDest(nodeId.id, '');
    }

    async fillWithBacklinks(nodes: Record<string, NodeDefinition>, nodeId: VizId) {
      // Could be an expensive operation... No cached backlinks implementation is available in the Obsidian API though.
      if (nodeId.storeId === 'core') {
        const path = this.getFile(nodeId).path;
        // @ts-ignore
        const resolvedLinks = this.metadata.resolvedLinks;
        for (const otherPath of Object.keys(resolvedLinks)) {
          if (path in resolvedLinks[otherPath]) {
            const file = this.vault.getAbstractFileByPath(otherPath) as TFile;
            const id = VizId.fromFile(file).toId();
            if (!(id in nodes)) {
              nodes[id] = await nodeFromFile(file, this.plugin);
            }
          }
        }
      }
    }


    async getNeighbourhood(nodeIds: VizId[]): Promise<NodeDefinition[]> {
      const nodes: Record<string, NodeDefinition> = {};
      for (const nodeId of nodeIds) {
        if (nodeId.storeId === this.storeId()) {
          const file = this.getFile(nodeId);
          if (file === null) {
            continue;
          }
          const cache = this.metadata.getFileCache(file);
          if (cache === null) {
            continue;
          }
          if (!(nodeId.toId() in nodes)) {
            nodes[nodeId.toId()] = await nodeFromFile(file, this.plugin);
          }
          const promiseNodes: Record<string, Promise<NodeDefinition>> = {};
          iterateCacheRefs(cache, (ref) => {
            const id = this.getOtherId(ref, file.path).toId();
            if (!(id in nodes)) {
              promiseNodes[id] = this.getNodeFromLink(ref, file.path);
            }
          });
          for (const id of Object.keys(promiseNodes)) {
            if (!(id in nodes)) {
              nodes[id] = await promiseNodes[id];
            }
          }
          await this.fillWithBacklinks(nodes, nodeId);
        }
      }
      return Object.values(nodes);
    }

    storeId(): string {
      return 'core';
    }

    get(nodeId: VizId): Promise<NodeDefinition> {
      const file = this.getFile(nodeId);
      if (file === null) {
        return null;
      }
      const cache = this.metadata.getFileCache(file);
      if (cache === null) {
        console.log('returning empty cache', nodeId);
        return null;
      }
      return Promise.resolve(nodeFromFile(file, this.plugin));
    }

    async refreshNode(view: IJuggl, id: VizId) {
      const idS = id.toId();
      let correctEdges: IMergedToGraph;
      let node = view.viz.$id(idS);
      if (this.getFile(id) === null) {
        // File does not exist
        if (node) {
          // If a node exists for this file, remove it.
          node.remove();
          view.onGraphChanged(true, true);
        }
        return;
      }
      if (node.length > 0 && node.hasClass(CLASS_EXPANDED)) {
        correctEdges = await view.expand(node, true, false);
      } else {
        const nodeDef = await this.get(id);
        view.mergeToGraph([nodeDef], true, false);
        node = view.viz.$id(idS);
        const edges = await view.buildEdges(node);
        correctEdges = view.mergeToGraph(edges, true, false);
      }
      // Remove outgoing edges that no longer exist.
      const removed = node.connectedEdges()
          .difference(correctEdges.merged)
          .remove();
      if (removed.length > 0 || correctEdges.added.length > 0) {
        view.onGraphChanged(true, true);
      }
    }

    onload() {
      super.onload();
      const store = this;
      this.registerEvent(
          this.metadata.on('changed', (file) => {
            store.plugin.activeGraphs().forEach(async (v) => {
              await store.refreshNode(v, VizId.fromFile(file));
            });
          }));
      this.registerEvent(
          this.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile) {
              const id = VizId.fromFile(file);
              const oldId = VizId.fromPath(oldPath);
              store.plugin.activeGraphs().forEach(async (v) => {
                setTimeout(async ()=> {
                  // Changing the ID of a node in Cytoscape is not allowed, so remove and then restore.
                  // Put in setTimeout because Obsidian doesn't immediately update the metadata on rename...
                  v.viz.$id(oldId.toId()).remove();
                  await store.refreshNode(v, id);
                }, 500);
              });
            }
          }));
      this.registerEvent(
          this.vault.on('delete', (file) => {
            if (file instanceof TFile) {
              store.plugin.activeGraphs().forEach((v) => {
                v.viz.$id(VizId.fromFile(file).toId()).remove();
              });
            }
          }));
    }
}
