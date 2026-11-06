/** 选择本地图片：cloud 模式上传云存储；local 模式直接使用临时路径 */
const dataSource = require('./data-source')

function chooseAndUpload(folder) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success(res) {
        const file = (res.tempFiles || [])[0]
        if (!file || !file.tempFilePath) {
          reject(new Error('未选择图片'))
          return
        }
        if (dataSource.isLocalMode()) {
          console.warn('[image] 当前为本地演示模式，图片只在本机临时可用')
          resolve(file.tempFilePath)
          return
        }
        const match = String(file.tempFilePath).match(/\.([a-zA-Z0-9]+)$/)
        const ext = match ? match[1] : 'jpg'
        const cloudPath = String(folder || 'images') + '/' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.' + ext
        wx.cloud
          .uploadFile({ cloudPath, filePath: file.tempFilePath })
          .then((res2) => resolve(res2.fileID))
          .catch((err) => reject(new Error((err && (err.errMsg || err.message)) || '上传失败')))
      },
      fail(err) {
        reject(new Error((err && (err.errMsg || err.message)) || '选择图片失败'))
      }
    })
  })
}

module.exports = { chooseAndUpload }
