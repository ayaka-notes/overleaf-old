import React, { useEffect } from 'react'
import withErrorBoundary from '../../../infrastructure/error-boundary'
import { useProjectContext } from '../../../shared/context/project-context'
import { useFileTreeData } from '../../../shared/context/file-tree-data-context'
import FileTreeContext from './file-tree-context'
import FileTreeDraggablePreviewLayer from './file-tree-draggable-preview-layer'
import FileTreeFolderList from './file-tree-folder-list'
import FileTreeToolbar from './file-tree-toolbar'
import FileTreeModalDelete from './modals/file-tree-modal-delete'
import FileTreeModalCreateFolder from './modals/file-tree-modal-create-folder'
import FileTreeModalError from './modals/file-tree-modal-error'
import FileTreeContextMenu from './file-tree-context-menu'
import FileTreeError from './file-tree-error'
import { useDroppable } from '../contexts/file-tree-draggable'
import { useFileTreeSocketListener } from '../hooks/file-tree-socket-listener'
import FileTreeModalCreateFile from './modals/file-tree-modal-create-file'
import FileTreeInner from './file-tree-inner'
import { useDragLayer } from 'react-dnd'
import classnames from 'classnames'

const FileTreeRoot = React.memo<{
  onSelect: () => void
  onDelete: () => void
  onInit: () => void
  isConnected: boolean
  setRefProviderEnabled: () => void
  setStartedFreeTrial: () => void
  reindexReferences: () => void
  refProviders: Record<string, boolean>
}>(function FileTreeRoot({
  refProviders,
  reindexReferences,
  setRefProviderEnabled,
  setStartedFreeTrial,
  onSelect,
  onInit,
  onDelete,
  isConnected,
}) {
  const { _id: projectId } = useProjectContext()
  const { fileTreeData } = useFileTreeData()
  const isReady = Boolean(projectId && fileTreeData)

  useEffect(() => {
    if (isReady) onInit()
  }, [isReady, onInit])
  if (!isReady) return null

  return (
    <FileTreeContext
      refProviders={refProviders}
      setRefProviderEnabled={setRefProviderEnabled}
      setStartedFreeTrial={setStartedFreeTrial}
      reindexReferences={reindexReferences}
      onSelect={onSelect}
    >
      {isConnected ? null : <div className="disconnected-overlay" />}
      <FileTreeToolbar />
      <FileTreeContextMenu />
      <FileTreeInner>
        <FileTreeRootFolder onDelete={onDelete} />
      </FileTreeInner>
      <FileTreeModalDelete />
      <FileTreeModalCreateFile />
      <FileTreeModalCreateFolder />
      <FileTreeModalError />
    </FileTreeContext>
  )
})

function FileTreeRootFolder({ onDelete }: { onDelete: () => void }) {
  useFileTreeSocketListener(onDelete)
  const { fileTreeData } = useFileTreeData()

  const { isOver, dropRef } = useDroppable(fileTreeData._id)

  const dragLayer = useDragLayer(monitor => ({
    isDragging: monitor.isDragging(),
    item: monitor.getItem(),
    clientOffset: monitor.getClientOffset(),
  }))

  return (
    <>
      <FileTreeDraggablePreviewLayer isOver={isOver} {...dragLayer} />
      <FileTreeFolderList
        folders={fileTreeData.folders}
        docs={fileTreeData.docs}
        files={fileTreeData.fileRefs}
        classes={{
          root: classnames('file-tree-list', {
            'file-tree-dragging': dragLayer.isDragging,
          }),
        }}
        dropRef={dropRef as any}
        dataTestId="file-tree-list-root"
      />
    </>
  )
}

export default withErrorBoundary(FileTreeRoot, FileTreeError)
