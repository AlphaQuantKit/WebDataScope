// dataAna.js: 数据分析脚本
console.log('dataAna.js loaded');

let cacheData = {}; // 缓存数据
let cacheDataOtherUniverse = {}; // 缓存数据(其他Universe)

let sum = function (x, y) { return x + y; };

function getDataFieldId(node) {
    // 从当前节点开始向上查找，直到找到包含指定类名的节点
    // console.log('raw', node)

    const className = "rt-tr";
    while (node) {
        if (node && node.classList && node.classList.contains(className)) {
            const linkElement = node.querySelector('.link--wrap');
            // console.log('last', node)
            return {
                dataFieldHtml: node,
                dataFieldUrl: linkElement ? linkElement.href : null
            };
        }
        node = node.parentNode || null;
    }
    return { dataFieldHtml: null, dataFieldUrl: null };
}

function getDataFieldData(dataFieldHtml, dataFieldUrl) {
    // 从URL中提取数据集和数据字段

    let regex = null;
    let currentUrl = window.location.href;
    // console.log('currentUrl', currentUrl)
    if (!currentUrl.includes('data-sets') && currentUrl.includes('data-fields')) {
        currentUrl = dataFieldHtml.parentNode.parentNode.querySelector('.link--wrap').href;
        regex = /\/data-sets\/([^?#]+)(.*)?/;
    } else {
        regex = /\/data-sets\/([^?#]+)(\?.*)?/;
    }

    const match = currentUrl.match(regex);
    // console.log('currentUrl', currentUrl, match)

    if (!match || dataFieldUrl.includes('data-sets')) {
        return null;
    }

    const urlObj = new URL(dataFieldUrl);
    const path = urlObj.pathname;

    const data = {};
    data['dataSet'] = match[1];
    data['dataField'] = path.split('/').pop();

    // Make sure elements exist before querying their children
    const delayElement = document.getElementById('data-delay');
    const regionElement = document.getElementById('data-region');
    const universeElement = document.getElementById('data-universe');

    if (delayElement && regionElement && universeElement) {
        data['delay'] = delayElement.querySelector('[aria-selected="true"]')?.firstChild?.innerHTML || '';
        data['region'] = regionElement.querySelector('[aria-selected="true"]')?.firstChild?.innerHTML || '';
        data['universe'] = universeElement.querySelector('[aria-selected="true"]')?.firstChild?.innerHTML || '';
    } else {
        return null;
    }

    // console.log('data', data)
    return data;
}

async function fetchDataDetails(fileName, dataFieldData) {
    // 通过文件名获取数据

    // 获取数据集列表
    if (!cacheData['dataSetList']) {
        const response = await fetch(chrome.runtime.getURL(`data/dataSetList.json`));
        cacheData['dataSetList'] = await response.json();
    }
    const dataSetList = cacheData['dataSetList'];

    // 检查数据集列表中是否存在文件名, 无则尝试匹配其他Universe
    if (!dataSetList.includes(fileName)) {
        const startPrefix = `${dataFieldData.dataSet}_${dataFieldData.region}_`;
        const endPrefix = `_Delay${dataFieldData.delay}`;
        const partialMatchRegion = dataSetList.find(item => item.startsWith(startPrefix) && item.endsWith(endPrefix));
        if (partialMatchRegion) {
            cacheDataOtherUniverse[fileName] = [partialMatchRegion, partialMatchRegion.replace(startPrefix, '').replace(endPrefix, '')];
        }
    }

    // 根据文件名获取数据
    let perfectMatch = true;
    let universe = dataFieldData.universe;
    if (cacheDataOtherUniverse[fileName]) {
        [fileName, universe] = cacheDataOtherUniverse[fileName];
        perfectMatch = false;
    }

    if (cacheData[fileName]) {
        return [cacheData[fileName], perfectMatch, universe];
    }

    // 从文件中获取数据
    let url = chrome.runtime.getURL(`data/${fileName}.bin`);
    try {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const inflatedData = pako.inflate(arrayBuffer);
        const decodedData = msgpack.decode(new Uint8Array(inflatedData));
        cacheData[fileName] = decodedData;
        return decodedData, perfectMatch, universe;
    } catch (error) {
        // console.log("error", error);
        return;
    }
}

function anaDis(rawData) {
    // 对分布数据进行排序

    let bins = [];
    let data = [];

    // 先将键排序
    const sortedKeys = Object.keys(rawData).sort((a, b) => {
        const aLowerBound = parseFloat(a.match(/\d+\.?\d*/g)[0]);
        const bLowerBound = parseFloat(b.match(/\d+\.?\d*/g)[0]);
        return aLowerBound - bLowerBound;
    });

    // 然后遍历排序后的键
    sortedKeys.forEach((key, index) => {
        const bounds = key.match(/\d+\.?\d*/g).map(Number);
        // 对于数组的第一个元素，添加其下界
        if (index === 0) bins.push(bounds[0]);
        // 添加上界
        bins.push(bounds[1]);
        // 添加对应的数据值
        data.push(rawData[key]);
    });
    return [bins, data];
}

async function updateCardInfo(dataId, data, updateDataCallback) {
    // 更新卡片信息

    const fileName = data.dataSet + "_" + data.region + "_" + data.universe + "_Delay" + data.delay;
    const dataField = data.dataField;

    const [matchData, perfectMatch, matchUniverse] = await fetchDataDetails(fileName, data);
    let itemData = matchData[dataField];
    try {
        tmp = itemData['yearly_distribution'];
        tmp = tmp.replace(/\(/g, '{').replace(/\)/g, '}');
        tmp = tmp.replace(/({\d+(\.\d+)?, \d+(\.\d+)?})/g, '"$1"');
        itemData['yearly_distribution'] = JSON.parse(tmp)
    } catch (error) {
    } finally {
        const container = document.createElement('div');
        container.classList.add('canvas-container');
        container.innerHTML = `
            <div class="dataInfo">
                <ul>
                    <li><span id='frequency'></span></li>
                    <li><span id='coverage'></span></li>
                    <li><span id='coverageRatio'></span></li>
                    <li><span id='posRatio'></span></li>
                    <li><span id='negRatio'></span></li>
                    <li><span id='abs01Ratio'></span></li>
                    <li><span id='intStat'></span></li>
                    <li><span id='skew'></span></li>
                    <li><span id='kurt'></span></li>
                </ul>

            </div>
            <div class="canvasDataInfo"><canvas id="WQAnaDataHist"></canvas></div>
            <div class="canvas"><canvas id="WQAnaDataHist0"></canvas></div>
            <div class="canvas"><canvas id="WQAnaDataHist1"></canvas></div>
            <div class="canvas"><canvas id="WQAnaDataHist2"></canvas></div>
            <div class="canvas"><canvas id="WQAnaDataHist3"></canvas></div>
            <div class="canvas"><canvas id="WQAnaDataHist4"></canvas></div>
            <div class="canvas"><canvas id="WQAnaDataHist5"></canvas></div>
            <div class="canvas"><canvas id="WQAnaDataHist6"></canvas></div>
            <div class="canvas"><canvas id="WQAnaDataHist7"></canvas></div>
            <div class="canvas"><canvas id="WQAnaDataHist8"></canvas></div>
            <div class="canvas"><canvas id="WQAnaDataHist9"></canvas></div>
            `;
        const cardTitle = `${dataField} 分析报告` + (perfectMatch ? '' : `(from ${matchUniverse})`);
        const cardContent = container.outerHTML;
        updateDataCallback(cardTitle, cardContent);



        document.getElementById("frequency").innerHTML = `更新频率: ${itemData['frequency']}`;
        document.getElementById("coverage").innerHTML = `覆盖数: ${(itemData['Coverage'].reduce(sum) / itemData['Coverage'].length).toFixed(0)}`;
        document.getElementById("coverageRatio").innerHTML = `覆盖率: ${(itemData['CoverageRatio'].reduce(sum) / itemData['CoverageRatio'].length).toFixed(2)}`;
        document.getElementById("posRatio").innerHTML = `正值占比: ${(itemData['IndicativePositiveRatio'].reduce(sum) / itemData['IndicativePositiveRatio'].length).toFixed(2)}`;
        document.getElementById("negRatio").innerHTML = `负值占比: ${(itemData['IndicativeNegativeRatio'].reduce(sum) / itemData['IndicativeNegativeRatio'].length).toFixed(2)}`;
        document.getElementById("abs01Ratio").innerHTML = `abs在[0,1]的占比: ${(itemData['absValueBetween1and0ratio'].reduce(sum) / itemData['absValueBetween1and0ratio'].length).toFixed(2)}`;
        document.getElementById("intStat").innerHTML = `是否为整数: ${itemData['IntegerStatus']}`;
        document.getElementById("skew").innerHTML = `偏度: ${itemData['skenewss']}`;
        document.getElementById("kurt").innerHTML = `峰度: ${itemData['kurtosis']}`;

        const ctx = document.getElementById(`WQAnaDataHist`).getContext('2d');

        const myHistogram = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021], // 生成X轴的标签
                datasets: [{
                    label: '覆盖率',
                    data: itemData['CoverageRatio'], // 使用计算出的频率数据
                    fill: false,
                    // borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 1,
                    tension: 0.1
                }, {
                    label: '正值占比',
                    data: itemData['IndicativePositiveRatio'], // 使用计算出的频率数据
                    fill: false,
                    // borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 1,
                    tension: 0.1
                }, {
                    label: '负值占比',
                    data: itemData['IndicativeNegativeRatio'], // 使用计算出的频率数据
                    fill: false,
                    // borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 1,
                    tension: 0.1
                }, {
                    label: 'abs在[0,1]的占比',
                    data: itemData['absValueBetween1and0ratio'], // 使用计算出的频率数据
                    fill: false,
                    // borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 1,
                    tension: 0.1
                },
                ]
            },
            options: {
                maintainAspectRatio: false,
                responsive: true,
                animations: false,
                scales: {
                    y: {
                        min: 0, // 设置 Y 轴的最小值
                        max: 1, // 设置 Y 轴的最大值
                        beginAtZero: true // 确保 Y 轴从 0 开始
                    },
                },
            },
        });

        for (var i = 0; i < itemData['yearly_distribution'].length; i++) {

            let result = anaDis(itemData['yearly_distribution'][i]);
            let bins = result[0];
            let bins_data = result[1];
            const ctx = document.getElementById(`WQAnaDataHist${i}`).getContext('2d');
            const myHistogram = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: bins, // 生成X轴的标签
                    datasets: [{
                        label: 'Frequency',
                        data: bins_data, // 使用计算出的频率数据
                        backgroundColor: 'rgba(75, 192, 192, 0.2)',
                        borderColor: 'rgba(75, 192, 192, 1)',
                        borderWidth: 1
                    }]
                },
                options: {
                    maintainAspectRatio: false,
                    responsive: true,
                    animations: false,
                    scales: {
                        y: {
                            beginAtZero: true
                        },
                    },
                    plugins: {
                        legend: {
                            display: false // 通过这里隐藏图例
                        }
                    },
                },
            });
        }
    }
}

async function showDataCard(event) {
    // 扩展热重载后上下文失效，静默忽略
    if (!chrome.runtime?.id) return;
    // 显示数据卡片
    chrome.storage.local.get('WQPSettings', async ({ WQPSettings }) => {
        if (WQPSettings.dataAnalysisEnabled) {
            const { dataFieldHtml, dataFieldUrl } = getDataFieldId(event.target);
            if (dataFieldUrl) {
                const data = getDataFieldData(dataFieldHtml, dataFieldUrl);
                if (data) {
                    const dataId = data.dataSet + "_" + data.region + "_" + data.universe + "_Delay" + data.delay + "_" + data.dataField;
                    if (card.enable(dataId)) {
                        try {
                            card.updateDataId(dataId);
                            card.updateCursor(event.clientX, event.clientY);
                            card.updateTargetHtml(dataFieldHtml);
                            await updateCardInfo(dataId, data, (cardTitle, cardContent) => card.updateData(cardTitle, cardContent));
                            return;
                        } catch (error) {
                            card.el.innerHTML = getCommonCardHTML();
                            card.disable();
                        }
                    } else {
                        return;
                    }
                }
            }
        }
        card.disable();
        return;
    });

}

// 监听鼠标移动事件
document.addEventListener("mouseover", showDataCard);
document.addEventListener("mousemove", (ev) => card.updateCursor(ev.pageX, ev.pageY));
